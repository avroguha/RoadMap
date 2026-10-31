// devidp is a TEST SAML identity provider for the home lab: it answers like
// Microsoft Entra ID (same claim names, signed assertions, federation
// metadata at /metadata), so RoadMap Studio's real sign-in path can be tried
// without Azure. Anyone can sign in as anyone. Never run it anywhere real.
//
//	go build -o devidp ./tools/devidp
//	./devidp -base http://192.168.5.254:8090 -sp https://192.168.5.254/saml/metadata
package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"encoding/xml"
	"flag"
	"fmt"
	"html/template"
	"io"
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
)

const (
	tenantID = "11111111-2222-3333-4444-555555555555"
	nsAzure  = "http://schemas.microsoft.com/identity/claims/"
	nsSOAP   = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/"
)

// Alice and Bob are in the "roadmap users" group, Carol in "contractors":
// enough to try an allow list and a deny list.
const (
	groupUsers       = "aaaaaaaa-0000-0000-0000-000000000001"
	groupContractors = "aaaaaaaa-0000-0000-0000-000000000002"
)

var people = []struct {
	Name, Email string
	Groups      []string
}{
	{"Alice Adams", "alice@example.test", []string{groupUsers}}, {"Bob Brown", "bob@example.test", []string{groupUsers}},
	{"Carol Chen", "carol@example.test", []string{groupContractors}},
}

func main() {
	base := flag.String("base", "http://127.0.0.1:8090", "this IdP's own address")
	spMeta := flag.String("sp", "https://127.0.0.1/saml/metadata", "the app's SAML metadata URL")
	state := flag.String("state", "devidp-state", "folder for the signing key, so it survives restarts")
	listen := flag.String("listen", ":8090", "listen address")
	flag.Parse()

	key, cert := keyPair(*state)
	b, _ := url.Parse(*base)
	meta, sso := *b, *b
	meta.Path, sso.Path = "/metadata", "/sso"
	sp := &spProvider{url: *spMeta}
	idp := &saml.IdentityProvider{
		Key: key, Certificate: cert, MetadataURL: meta, SSOURL: sso, LoginURL: sso,
		ServiceProviderProvider: sp, SessionProvider: &sessions{},
		Logger: log.Default(),
	}
	http.HandleFunc("/metadata", idp.ServeMetadata)
	http.HandleFunc("/sso", idp.ServeSSO)
	log.Printf("TEST identity provider on %s (metadata %s), app metadata from %s", *listen, meta.String(), *spMeta)
	log.Fatal(http.ListenAndServe(*listen, nil))
}

func keyPair(dir string) (*rsa.PrivateKey, *x509.Certificate) {
	os.MkdirAll(dir, 0o700)
	p := filepath.Join(dir, "idp.pem")
	if raw, err := os.ReadFile(p); err == nil {
		var key *rsa.PrivateKey
		var cert *x509.Certificate
		for rest := raw; ; {
			var blk *pem.Block
			if blk, rest = pem.Decode(rest); blk == nil {
				break
			}
			if blk.Type == "RSA PRIVATE KEY" {
				key, _ = x509.ParsePKCS1PrivateKey(blk.Bytes)
			} else if blk.Type == "CERTIFICATE" {
				cert, _ = x509.ParseCertificate(blk.Bytes)
			}
		}
		if key != nil && cert != nil {
			return key, cert
		}
	}
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	tpl := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: "devidp TEST signing"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().AddDate(3, 0, 0), KeyUsage: x509.KeyUsageDigitalSignature}
	der, _ := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	cert, _ := x509.ParseCertificate(der)
	var out []byte
	out = append(out, pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})...)
	out = append(out, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})...)
	os.WriteFile(p, out, 0o600)
	return key, cert
}

// spProvider fetches the app's metadata (self-signed HTTPS in the lab).
type spProvider struct {
	url  string
	mu   sync.Mutex
	md   *saml.EntityDescriptor
	when time.Time
}

func (s *spProvider) GetServiceProvider(_ *http.Request, _ string) (*saml.EntityDescriptor, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.md != nil && time.Since(s.when) < time.Minute {
		return s.md, nil
	}
	c := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
	resp, err := c.Get(s.url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var md saml.EntityDescriptor
	if err := xml.Unmarshal(body, &md); err != nil {
		return nil, fmt.Errorf("app metadata: %w", err)
	}
	s.md, s.when = &md, time.Now()
	return s.md, nil
}

type sessions struct{}

var form = template.Must(template.New("f").Parse(`<!doctype html><meta charset="utf-8"><title>TEST sign-in</title>
<style>body{font:15px system-ui;background:#1f2a44;color:#fff;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.c{background:#fff;color:#1c2434;border-radius:14px;padding:26px;width:380px}.w{background:#d8434e;color:#fff;padding:6px 10px;border-radius:8px;font-weight:700}
button{display:block;width:100%;margin:8px 0;padding:10px;border-radius:9px;border:1px solid #ccd;background:#f4f6fb;font:inherit;cursor:pointer;text-align:left}
input{width:100%;box-sizing:border-box;padding:8px;margin:4px 0;border-radius:8px;border:1px solid #ccd}</style>
<div class="c"><div class="w">TEST IDENTITY PROVIDER - not Microsoft</div><h3>Sign in as</h3>
{{range .People}}<form method="post" action="/sso"><input type="hidden" name="SAMLRequest" value="{{$.Req}}"><input type="hidden" name="RelayState" value="{{$.Relay}}">
<input type="hidden" name="name" value="{{.Name}}"><button name="email" value="{{.Email}}">{{.Name}} &lt;{{.Email}}&gt;</button></form>{{end}}
<form method="post" action="/sso"><input type="hidden" name="SAMLRequest" value="{{.Req}}"><input type="hidden" name="RelayState" value="{{.Relay}}">
<input name="name" placeholder="Any name"><input name="email" placeholder="any@example.test"><input name="groups" placeholder="group ids, comma-separated"><button>Sign in</button></form></div>`))

func (sessions) GetSession(w http.ResponseWriter, r *http.Request, req *saml.IdpAuthnRequest) *saml.Session {
	email := strings.ToLower(strings.TrimSpace(r.FormValue("email")))
	if r.Method == http.MethodPost && strings.Contains(email, "@") {
		name := strings.TrimSpace(r.FormValue("name"))
		if name == "" {
			name = strings.SplitN(email, "@", 2)[0]
		}
		given, family, _ := strings.Cut(name, " ")
		h := sha256.Sum256([]byte(email))
		oid := fmt.Sprintf("%s-%s-%s-%s-%s", hex.EncodeToString(h[0:4]), hex.EncodeToString(h[4:6]), hex.EncodeToString(h[6:8]), hex.EncodeToString(h[8:10]), hex.EncodeToString(h[10:16]))
		attr := func(n, v string) saml.Attribute {
			return saml.Attribute{Name: n, NameFormat: "urn:oasis:names:tc:SAML:2.0:attrname-format:uri", Values: []saml.AttributeValue{{Type: "xs:string", Value: v}}}
		}
		groups := strings.Split(r.FormValue("groups"), ",")
		for _, p := range people {
			if p.Email == email {
				groups = p.Groups
			}
		}
		var extra []saml.Attribute
		for _, g := range groups {
			if g = strings.TrimSpace(g); g != "" {
				extra = append(extra, attr("http://schemas.microsoft.com/ws/2008/06/identity/claims/groups", g)) // the URI Azure uses for groups
			}
		}
		return &saml.Session{
			ID: base64.RawURLEncoding.EncodeToString(randomBytes(16)), CreateTime: time.Now(), ExpireTime: time.Now().Add(time.Hour),
			Index: hex.EncodeToString(randomBytes(16)), NameID: email,
			NameIDFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
			CustomAttributes: append([]saml.Attribute{
				attr(nsAzure+"tenantid", tenantID), attr(nsAzure+"objectidentifier", oid), attr(nsAzure+"displayname", name),
				attr(nsSOAP+"emailaddress", email), attr(nsSOAP+"name", email), attr(nsSOAP+"givenname", given), attr(nsSOAP+"surname", family),
			}, extra...),
		}
	}
	form.Execute(w, map[string]any{"People": people, "Req": base64.StdEncoding.EncodeToString(req.RequestBuffer), "Relay": req.RelayState})
	return nil
}

func randomBytes(n int) []byte {
	b := make([]byte, n)
	rand.Read(b)
	return b
}
