package main

// Single sign-on with Microsoft Entra ID (Azure AD) over SAML 2.0.
//
// Set up entirely from XML, in both directions:
//   * The app reads the tenant's federation metadata (RMS_SAML_METADATA_URL,
//     the "App Federation Metadata Url" on the Enterprise Application's
//     Single sign-on page, or a downloaded copy in RMS_SAML_METADATA_FILE).
//     That gives it the sign-in address, the issuer and the signing
//     certificates. It is read again every day, so a certificate rollover in
//     Azure needs nothing here; the last good copy is kept in the database so
//     a restart works even while Azure is unreachable.
//   * The app publishes its own metadata at /saml/metadata. Upload that file
//     with "Upload metadata file" in Azure and the Identifier and Reply URL
//     are filled in.
//
// Whoever Azure lets through is created on first sign-in from the claims in
// the assertion. Who gets through is decided in Azure ("Assignment required"
// plus Users and groups), optionally narrowed with RMS_SAML_ALLOWED_GROUPS.

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"encoding/xml"
	"errors"
	"fmt"
	"html/template"
	"log"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/crewjam/saml"
	"github.com/crewjam/saml/samlsp"
)

// Claim names Azure puts in a SAML assertion by default.
const (
	claimObjectID = "http://schemas.microsoft.com/identity/claims/objectidentifier"
	claimTenantID = "http://schemas.microsoft.com/identity/claims/tenantid"
	claimDisplay  = "http://schemas.microsoft.com/identity/claims/displayname"
	claimEmail    = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"
	claimUPN      = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"
	claimGiven    = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname"
	claimSurname  = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname"
	claimGroups   = "http://schemas.microsoft.com/ws/2008/06/identity/claims/groups"
)

const samlFlowCookie = "rms_saml"

type idpCert struct {
	Subject  string    `json:"subject"`
	NotAfter time.Time `json:"notAfter"`
}

type samlState struct {
	mu          sync.RWMutex
	sp          *saml.ServiceProvider
	source      string
	loadedAt    time.Time
	idpEntity   string
	certs       []idpCert
	lastErr     string
	lastAttempt time.Time
}

func (st *samlState) get() (*saml.ServiceProvider, string) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	return st.sp, st.lastErr
}

// outboundClient fetches the metadata: through RMS_OUTBOUND_PROXY when set,
// trusting /certs/ca.crt as well when a proxy re-signs TLS.
func (s *server) outboundClient() *http.Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = nil
	if s.cfg.OutboundProxy != "" {
		if u, err := url.Parse(s.cfg.OutboundProxy); err == nil {
			tr.Proxy = http.ProxyURL(u)
		}
	}
	if pem, err := os.ReadFile(filepath.Join(s.cfg.TLSDir, "ca.crt")); err == nil {
		pool, _ := x509.SystemCertPool()
		if pool == nil {
			pool = x509.NewCertPool()
		}
		if pool.AppendCertsFromPEM(pem) {
			tr.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
		}
	}
	return &http.Client{Transport: tr, Timeout: 30 * time.Second}
}

// spKeyPair returns the service provider's key and certificate, made once
// and shared by every instance through the database. Azure only uses them if
// someone turns on token encryption; requests are not signed.
func (s *server) spKeyPair(ctx context.Context) (*rsa.PrivateKey, *x509.Certificate, error) {
	raw, err := sharedSecret(ctx, s.db, "saml_sp_keypair", func() ([]byte, error) {
		key, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			return nil, err
		}
		tpl := &x509.Certificate{
			SerialNumber: new(big.Int).SetBytes(randomBytes(16)),
			Subject:      pkix.Name{CommonName: "RoadMap Studio " + s.cfg.PublicURL.Host},
			NotBefore:    time.Now().Add(-time.Hour),
			NotAfter:     time.Now().AddDate(10, 0, 0),
			KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		}
		der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
		if err != nil {
			return nil, err
		}
		var b bytes.Buffer
		pem.Encode(&b, &pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
		pem.Encode(&b, &pem.Block{Type: "CERTIFICATE", Bytes: der})
		return b.Bytes(), nil
	})
	if err != nil {
		return nil, nil, err
	}
	var key *rsa.PrivateKey
	var cert *x509.Certificate
	for rest := raw; ; {
		var blk *pem.Block
		if blk, rest = pem.Decode(rest); blk == nil {
			break
		}
		switch blk.Type {
		case "RSA PRIVATE KEY":
			key, err = x509.ParsePKCS1PrivateKey(blk.Bytes)
		case "CERTIFICATE":
			cert, err = x509.ParseCertificate(blk.Bytes)
		}
		if err != nil {
			return nil, nil, err
		}
	}
	if key == nil || cert == nil {
		return nil, nil, errors.New("stored SAML key pair is incomplete")
	}
	return key, cert, nil
}

func (s *server) newSP(key *rsa.PrivateKey, cert *x509.Certificate, md *saml.EntityDescriptor) *saml.ServiceProvider {
	meta, _ := url.Parse(s.cfg.abs("/saml/metadata"))
	acs, _ := url.Parse(s.cfg.abs("/saml/acs"))
	return &saml.ServiceProvider{
		EntityID:           s.entityID(),
		Key:                key,
		Certificate:        cert,
		MetadataURL:        *meta,
		AcsURL:             *acs,
		IDPMetadata:        md,
		AllowIDPInitiated:  true, // people also start from the tile in My Apps
		DefaultRedirectURI: "/",
		HTTPClient:         s.outboundClient(),
	}
}

// loadIDPMetadata reads the metadata from its source; on failure it falls
// back to the last good copy stored in the database.
func (s *server) loadIDPMetadata(ctx context.Context) error {
	st := &s.saml
	st.mu.Lock()
	st.lastAttempt = time.Now()
	st.mu.Unlock()

	key, cert, err := s.spKeyPair(ctx)
	if err != nil {
		return fmt.Errorf("service provider key: %w", err)
	}
	raw, source, err := s.readIDPMetadata(ctx, s.ssoSettings())

	fromCache := false
	if err != nil {
		var cached struct {
			Source string    `json:"source"`
			XML    []byte    `json:"xml"`
			At     time.Time `json:"at"`
		}
		var blob []byte
		if qerr := s.db.QueryRow(ctx, "SELECT value FROM app_secrets WHERE name='saml_idp_metadata'").Scan(&blob); qerr == nil && json.Unmarshal(blob, &cached) == nil && len(cached.XML) > 0 {
			log.Printf("SAML: reading identity provider metadata from %s failed (%v); using the copy saved %s", source, err, cached.At.Format(time.RFC3339))
			st.mu.Lock()
			st.lastErr = fmt.Sprintf("could not read %s (%v); using the copy saved %s", source, err, cached.At.Format("2006-01-02 15:04"))
			st.mu.Unlock()
			raw, fromCache = cached.XML, true
		} else {
			st.mu.Lock()
			st.lastErr = fmt.Sprintf("could not read the identity provider metadata from %s: %v", source, err)
			st.mu.Unlock()
			return errors.New(st.lastErr)
		}
	}

	md, err := samlsp.ParseMetadata(raw)
	if err != nil {
		st.mu.Lock()
		st.lastErr = fmt.Sprintf("the metadata from %s is not SAML federation metadata: %v", source, err)
		st.mu.Unlock()
		return errors.New(st.lastErr)
	}
	if len(md.IDPSSODescriptors) == 0 {
		return fmt.Errorf("the metadata from %s describes no identity provider (no IDPSSODescriptor)", source)
	}
	sp := s.newSP(key, cert, md)
	if sp.GetSSOBindingLocation(saml.HTTPRedirectBinding) == "" {
		return fmt.Errorf("the metadata from %s has no HTTP-Redirect sign-in address", source)
	}

	certs := idpCerts(md)

	st.mu.Lock()
	st.sp, st.source, st.loadedAt, st.idpEntity, st.certs = sp, source, time.Now(), md.EntityID, certs
	if !fromCache {
		st.lastErr = ""
	}
	st.mu.Unlock()

	if !fromCache {
		blob, _ := json.Marshal(map[string]any{"source": source, "xml": raw, "at": time.Now()})
		s.db.Exec(ctx, `INSERT INTO app_secrets (name, value) VALUES ('saml_idp_metadata', $1)
			ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, blob)
		log.Printf("SAML: identity provider %s loaded from %s (%d signing certificate(s))", md.EntityID, source, len(certs))
	}
	return nil
}

// idpCerts lists the signing certificates, each once (metadata often lists
// the same certificate for signing and for encryption).
func idpCerts(md *saml.EntityDescriptor) []idpCert {
	var certs []idpCert
	seen := map[string]bool{}
	for _, kd := range md.IDPSSODescriptors[0].KeyDescriptors {
		if kd.Use != "" && kd.Use != "signing" {
			continue
		}
		for _, xc := range kd.KeyInfo.X509Data.X509Certificates {
			if seen[xc.Data] {
				continue
			}
			seen[xc.Data] = true
			der, err := base64.StdEncoding.DecodeString(strings.Join(strings.Fields(xc.Data), ""))
			if err != nil {
				continue
			}
			if c, err := x509.ParseCertificate(der); err == nil {
				certs = append(certs, idpCert{Subject: c.Subject.CommonName, NotAfter: c.NotAfter})
			}
		}
	}
	return certs
}

func xmlMarshal(v any) ([]byte, error) { return xml.Marshal(v) }

// refreshSAML keeps the metadata current: daily when healthy, every five
// minutes while it is failing.
func (s *server) refreshSAML(ctx context.Context) {
	for {
		wait := 24 * time.Hour
		if err := s.loadIDPMetadata(ctx); err != nil {
			log.Printf("SAML: %v", err)
			wait = 5 * time.Minute
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

// ---- handlers ---------------------------------------------------------------

func (s *server) handleSPMetadata(w http.ResponseWriter, r *http.Request) {
	key, cert, err := s.spKeyPair(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	sp, _ := s.saml.get()
	if sp == nil {
		sp = s.newSP(key, cert, nil)
	}
	md := sp.Metadata()
	// Azure wants the requested NameID and nothing that needs an IdP to know.
	buf, _ := xml.MarshalIndent(md, "", "  ")
	w.Header().Set("Content-Type", "application/samlmetadata+xml")
	w.Header().Set("Content-Disposition", `attachment; filename="roadmap-studio-saml-metadata.xml"`)
	w.Write([]byte(xml.Header))
	w.Write(buf)
}

type samlFlow struct {
	ReqID  string `json:"r"`
	Return string `json:"u"`
	Test   bool   `json:"t,omitempty"` // show the claims instead of signing in
}

func (s *server) handleSAMLLogin(w http.ResponseWriter, r *http.Request) {
	sp, lastErr := s.saml.get()
	if sp == nil {
		s.signinError(w, r, http.StatusServiceUnavailable, "Sign-in is not available yet",
			"RoadMap Studio could not read its identity provider's settings. "+lastErr)
		return
	}
	req, err := sp.MakeAuthenticationRequest(sp.GetSSOBindingLocation(saml.HTTPRedirectBinding), saml.HTTPRedirectBinding, saml.HTTPPostBinding)
	if err != nil {
		s.signinError(w, r, http.StatusInternalServerError, "Sign-in could not start", err.Error())
		return
	}
	// The request id and where to return go in a signed cookie, so the answer
	// can land on any instance. SameSite=None because Azure returns it with a
	// cross-site POST; that requires Secure, which plain-HTTP test setups lack.
	sameSite := http.SameSiteNoneMode
	if !s.cfg.secure() {
		sameSite = http.SameSiteLaxMode
	}
	flows := []samlFlow{}
	if c, err := r.Cookie(samlFlowCookie); err == nil {
		s.unsign(c.Value, &flows)
	}
	flows = append(flows, samlFlow{ReqID: req.ID, Return: safeReturn(r.URL.Query().Get("return")), Test: r.URL.Query().Get("test") == "1"})
	if len(flows) > 4 {
		flows = flows[len(flows)-4:] // several tabs signing in at once
	}
	http.SetCookie(w, &http.Cookie{Name: samlFlowCookie, Value: s.sign(flows, 15*time.Minute), Path: "/saml/",
		HttpOnly: true, Secure: s.cfg.secure(), SameSite: sameSite, MaxAge: 900})
	relay := base64.RawURLEncoding.EncodeToString(randomBytes(12))
	to, err := req.Redirect(relay, sp)
	if err != nil {
		s.signinError(w, r, http.StatusInternalServerError, "Sign-in could not start", err.Error())
		return
	}
	http.Redirect(w, r, to.String(), http.StatusFound)
}

func (s *server) handleSAMLACS(w http.ResponseWriter, r *http.Request) {
	sp, lastErr := s.saml.get()
	if sp == nil {
		s.signinError(w, r, http.StatusServiceUnavailable, "Sign-in is not available yet", lastErr)
		return
	}
	if err := r.ParseForm(); err != nil {
		s.signinError(w, r, http.StatusBadRequest, "Sign-in failed", "The answer from the identity provider could not be read.")
		return
	}
	var flows []samlFlow
	if c, err := r.Cookie(samlFlowCookie); err == nil {
		s.unsign(c.Value, &flows)
	}
	ids := make([]string, 0, len(flows))
	for _, f := range flows {
		ids = append(ids, f.ReqID)
	}
	assertion, err := sp.ParseResponse(r, ids)
	if err != nil {
		detail := err.Error()
		var ire *saml.InvalidResponseError
		if errors.As(err, &ire) && ire.PrivateErr != nil {
			detail = ire.PrivateErr.Error()
		}
		ref := base64.RawURLEncoding.EncodeToString(randomBytes(6))
		log.Printf("SAML sign-in refused [%s]: %s", ref, detail)
		s.signinError(w, r, http.StatusForbidden, "Sign-in failed",
			"The identity provider's answer was not accepted ("+explainSAML(detail)+"). Reference "+ref+" in the server log.")
		return
	}

	id, tenant := identityFrom(assertion)
	var flow samlFlow
	if resp := assertion.Subject; resp != nil {
		for _, sc := range resp.SubjectConfirmations {
			if sc.SubjectConfirmationData != nil {
				for _, f := range flows {
					if f.ReqID == sc.SubjectConfirmationData.InResponseTo {
						flow = f
					}
				}
			}
		}
	}
	if flow.Test {
		http.SetCookie(w, &http.Cookie{Name: samlFlowCookie, Value: "", Path: "/saml/", MaxAge: -1})
		s.renderSAMLTest(w, r, assertion, id, tenant)
		return
	}
	if want := s.ssoSettings().TenantID; want != "" && !strings.EqualFold(tenant, want) {
		s.signinError(w, r, http.StatusForbidden, "Sign-in refused", "This account belongs to a different Azure tenant.")
		return
	}
	uid, err := s.provision(r.Context(), id)
	if err != nil {
		s.signinError(w, r, http.StatusForbidden, "Sign-in refused", err.Error())
		return
	}
	if err := s.startSession(r.Context(), w, uid); err != nil {
		s.signinError(w, r, http.StatusInternalServerError, "Sign-in failed", err.Error())
		return
	}
	ret := "/"
	if flow.Return != "" {
		ret = flow.Return
	}
	http.SetCookie(w, &http.Cookie{Name: samlFlowCookie, Value: "", Path: "/saml/", MaxAge: -1})
	log.Printf("signed in: %s (%s)", id.Email, uid)
	http.Redirect(w, r, safeReturn(ret), http.StatusSeeOther)
}

// explainSAML turns the library's diagnostics into what an administrator
// should check.
func explainSAML(detail string) string {
	d := strings.ToLower(detail)
	switch {
	case strings.Contains(d, "audience"):
		return "it was issued for a different Identifier (Entity ID) - in Azure it must be exactly the one in /saml/metadata"
	case strings.Contains(d, "destination"):
		return "it was sent to a different Reply URL - in Azure it must be <public address>/saml/acs"
	case strings.Contains(d, "inresponseto") || strings.Contains(d, "request id"):
		return "it does not answer a sign-in this browser started; open the app again rather than an old link"
	case strings.Contains(d, "expired") || strings.Contains(d, "notonorafter") || strings.Contains(d, "notbefore"):
		return "it has expired or is not valid yet - check that this server's clock is right"
	case strings.Contains(d, "signature") || strings.Contains(d, "certificate"):
		return "its signature does not match the identity provider's certificate - the metadata may be out of date"
	}
	return "see the reference below"
}

// renderSAMLTest shows what the identity provider sent and what the app
// would do with it, for the "Test sign-in" button on the administration page.
func (s *server) renderSAMLTest(w http.ResponseWriter, r *http.Request, a *saml.Assertion, id identity, tenant string) {
	esc := template.HTMLEscapeString
	var b strings.Builder
	row := func(k, v string) { fmt.Fprintf(&b, `<tr><th>%s</th><td>%s</td></tr>`, esc(k), esc(v)) }
	b.WriteString(`<table class="kvt">`)
	row("Issuer", a.Issuer.Value)
	if a.Subject != nil && a.Subject.NameID != nil {
		row("NameID", a.Subject.NameID.Value+" ("+a.Subject.NameID.Format+")")
	}
	row("Tenant", tenant)
	for _, st := range a.AttributeStatements {
		for _, at := range st.Attributes {
			vals := make([]string, 0, len(at.Values))
			for _, v := range at.Values {
				vals = append(vals, v.Value)
			}
			row(at.Name, strings.Join(vals, ", "))
		}
	}
	b.WriteString(`</table><h3>What RoadMap Studio makes of it</h3><table class="kvt">`)
	row("Account key", id.ExternalID)
	row("Name", id.Name)
	row("Email", id.Email)
	row("Groups", fmt.Sprintf("%d", len(id.Groups)))
	verdict := "would sign in"
	var existing, isAdmin bool
	var name string
	if s.db.QueryRow(r.Context(), "SELECT true, is_admin, name FROM users WHERE external_id=$1", id.ExternalID).Scan(&existing, &isAdmin, &name) == nil {
		verdict += " as the existing account \"" + name + "\""
		if isAdmin {
			verdict += " (administrator)"
		}
	} else {
		verdict += " and create a new account"
	}
	if want := s.ssoSettings().TenantID; want != "" && !strings.EqualFold(tenant, want) {
		verdict = "REFUSED: the tenant " + tenant + " is not the pinned tenant " + want
	} else if err := s.groupCheck(id.Groups); err != nil {
		verdict = "REFUSED: " + err.Error()
	} else if id.ExternalID == "" {
		verdict = "REFUSED: no user identifier (object id or NameID) in the assertion"
	}
	row("Result", verdict)
	b.WriteString(`</table><p>No session was created by this test.</p><p>You can close this window.</p>`)
	renderPage(w, http.StatusOK, page{Wide: true, Title: "Single sign-on test: it works", Lines: []string{"The identity provider answered and its signature was accepted. This is what it sent:"}, Body: template.HTML(b.String())})
}

func identityFrom(a *saml.Assertion) (identity, string) {
	attrs := map[string][]string{}
	for _, st := range a.AttributeStatements {
		for _, at := range st.Attributes {
			for _, v := range at.Values {
				attrs[at.Name] = append(attrs[at.Name], v.Value)
				if at.FriendlyName != "" {
					attrs[at.FriendlyName] = append(attrs[at.FriendlyName], v.Value)
				}
			}
		}
	}
	first := func(names ...string) string {
		for _, n := range names {
			for _, v := range attrs[n] {
				if v = strings.TrimSpace(v); v != "" {
					return v
				}
			}
		}
		return ""
	}
	nameID := ""
	if a.Subject != nil && a.Subject.NameID != nil {
		nameID = strings.TrimSpace(a.Subject.NameID.Value)
	}
	id := identity{
		Email:  first(claimEmail, "email", "mail", claimUPN),
		Given:  first(claimGiven, "givenName"),
		Family: first(claimSurname, "sn", "surname"),
		Groups: append(append(attrs[claimGroups], attrs["groups"]...), attrs["http://schemas.microsoft.com/identity/claims/groups"]...),
	}
	if id.Email == "" && strings.Contains(nameID, "@") {
		id.Email = nameID
	}
	id.Name = first(claimDisplay, "displayName", "name", "cn")
	if id.Name == "" {
		id.Name = strings.TrimSpace(id.Given + " " + id.Family)
	}
	if id.Name == "" {
		id.Name = id.Email
	}
	// The Azure object id never changes, even when a name or address does.
	if oid := first(claimObjectID); oid != "" {
		id.ExternalID = "azure:" + strings.ToLower(oid)
	} else if nameID != "" {
		id.ExternalID = "nameid:" + strings.ToLower(nameID)
	}
	return id, first(claimTenantID)
}

// ---- pages around sign-in ---------------------------------------------------

var plainPage = template.Must(template.New("p").Parse(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>{{.Title}} - RoadMap Studio</title>
<style>
:root{--bg:#eef1f7;--card:#fff;--text:#1c2434;--muted:#6b7689;--accent:#4f6bed;--danger:#d8434e;--line:#e3e8f0}
@media (prefers-color-scheme:dark){:root{--bg:#0f131c;--card:#181d29;--text:#e7ebf3;--muted:#8d97ab;--accent:#7c93ff;--line:#2a3142}}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--text);font:14px "Segoe UI",system-ui,sans-serif}
.card{background:var(--card);border-radius:18px;box-shadow:0 12px 40px rgba(15,23,50,.14);padding:28px 30px;width:min(460px,92vw)}
h1{font-size:19px;margin:0 0 10px}p{color:var(--muted);line-height:1.55}
.btn{display:inline-block;margin-top:8px;padding:9px 16px;border-radius:10px;background:var(--accent);color:#fff;text-decoration:none;font-weight:600;border:0;font:inherit;cursor:pointer}
.warn{background:var(--danger);color:#fff;padding:8px 12px;border-radius:10px;font-weight:700;margin-bottom:14px}
label{display:block;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin:12px 0 4px}
input{width:100%;box-sizing:border-box;height:36px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--text);padding:0 10px;font:inherit}
.kvt{width:100%;border-collapse:collapse;font-size:12px;margin:8px 0}.kvt th{text-align:left;color:var(--muted);font-weight:600;padding:4px 8px 4px 0;vertical-align:top;max-width:45%;word-break:break-all}.kvt td{padding:4px 0;word-break:break-all}
.card.wide{width:min(760px,94vw)}
.alt{display:block;margin-top:16px;font-size:12.5px;color:var(--muted)}
.pick{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}.pick button{background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:10px;padding:7px 11px;cursor:pointer;font:inherit}
</style></head><body><div class="card{{if .Wide}} wide{{end}}">{{if .Warn}}<div class="warn">{{.Warn}}</div>{{end}}<h1>{{.Title}}</h1>{{range .Lines}}<p>{{.}}</p>{{end}}{{.Body}}</div></body></html>`))

type page struct {
	Title string
	Wide  bool
	Warn  string
	Lines []string
	Body  template.HTML
}

func renderPage(w http.ResponseWriter, status int, p page) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	plainPage.Execute(w, p)
}

func (s *server) signinError(w http.ResponseWriter, r *http.Request, status int, title, msg string) {
	renderPage(w, status, page{Title: title, Lines: []string{msg},
		Body: `<a class="btn" href="/login">Try again</a>` + s.localLink()})
}

// localLink: the way in for the local administrator, under the SSO pages.
func (s *server) localLink() template.HTML {
	if !s.cfg.LocalAdmin {
		return ""
	}
	return `<a class="alt" href="/auth/local">Administrator sign-in</a>`
}

// handleLogin starts sign-in: straight to Azure, or the test-login page.
func (s *server) handleLogin(w http.ResponseWriter, r *http.Request) {
	ret := safeReturn(r.URL.Query().Get("return"))
	if s.cfg.AuthMode == "dev" {
		http.Redirect(w, r, "/auth/dev?return="+url.QueryEscape(ret), http.StatusFound)
		return
	}
	if !s.ssoConfigured() {
		http.Redirect(w, r, "/auth/local?return="+url.QueryEscape(ret), http.StatusFound)
		return
	}
	http.Redirect(w, r, "/saml/login?return="+url.QueryEscape(ret), http.StatusFound)
}

func (s *server) handleLogout(w http.ResponseWriter, r *http.Request) {
	s.endSession(w, r)
	renderPage(w, http.StatusOK, page{Title: "You are signed out of RoadMap Studio",
		Lines: []string{"Your Microsoft account is still signed in on this computer, so signing in again does not ask for a password."},
		Body:  `<a class="btn" href="/login">Sign in again</a>` + s.localLink()})
}

// ---- test logins (RMS_AUTH_MODE=dev only) ----------------------------------

var devPeople = [][2]string{{"Alice Adams", "alice@example.test"}, {"Bob Brown", "bob@example.test"}, {"Carol Chen", "carol@example.test"}}

func (s *server) handleDevLogin(w http.ResponseWriter, r *http.Request) {
	if s.cfg.AuthMode != "dev" {
		http.NotFound(w, r)
		return
	}
	ret := safeReturn(r.URL.Query().Get("return"))
	if r.Method == http.MethodPost {
		if o := r.Header.Get("Origin"); o != "" && !sameOrigin(o, s.cfg.PublicURL) && !sameOrigin(o, requestOrigin(r)) {
			http.Error(w, "cross-site sign-in refused", http.StatusForbidden)
			return
		}
		email := strings.ToLower(strings.TrimSpace(r.FormValue("email")))
		name := strings.TrimSpace(r.FormValue("name"))
		if email == "" || !strings.Contains(email, "@") {
			http.Redirect(w, r, "/auth/dev?return="+url.QueryEscape(ret), http.StatusSeeOther)
			return
		}
		uid, err := s.provision(r.Context(), identity{ExternalID: "dev:" + email, Email: email, Name: name})
		if err != nil {
			s.signinError(w, r, http.StatusForbidden, "Sign-in refused", err.Error())
			return
		}
		if err := s.startSession(r.Context(), w, uid); err != nil {
			s.signinError(w, r, http.StatusInternalServerError, "Sign-in failed", err.Error())
			return
		}
		http.Redirect(w, r, safeReturn(r.FormValue("return")), http.StatusSeeOther)
		return
	}
	// No script on this page (the Content-Security-Policy would refuse it):
	// one small form per person.
	var b strings.Builder
	esc := template.HTMLEscapeString
	b.WriteString(`<div class="pick">`)
	for _, p := range devPeople {
		fmt.Fprintf(&b, `<form method="post" action="/auth/dev"><input type="hidden" name="return" value="%s"><input type="hidden" name="name" value="%s"><button name="email" value="%s">%s</button></form>`,
			esc(ret), esc(p[0]), esc(p[1]), esc(p[0]))
	}
	b.WriteString(`</div><form method="post" action="/auth/dev"><input type="hidden" name="return" value="` + esc(ret) + `">`)
	b.WriteString(`<label>Or any name</label><input name="name" placeholder="Full name"><label>Email</label><input name="email" placeholder="someone@example.test">`)
	b.WriteString(`<button class="btn" type="submit">Sign in</button></form>`)
	renderPage(w, http.StatusOK, page{Title: "Test sign-in", Warn: "TEST MODE - anyone can sign in as anyone. Never use this for real data.",
		Lines: []string{"RMS_AUTH_MODE=dev: there is no identity provider. Pick a person to sign in as."}, Body: template.HTML(b.String())})
}
