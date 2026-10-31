package main

// Single sign-on settings an administrator edits in the app: where the
// identity provider's metadata comes from (a URL or pasted XML), the entity
// id and tenant pin, and which Azure groups may or may not sign in. Saved in
// app_settings; the environment (deploy.env) only provides the starting values
// until something is saved here.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/crewjam/saml"
	"github.com/crewjam/saml/samlsp"
)

type ssoSettings struct {
	Source      string   `json:"source"`      // url | xml | file | "" (nothing configured)
	MetadataURL string   `json:"metadataUrl"` // when source = url
	MetadataXML string   `json:"metadataXml"` // when source = xml
	EntityID    string   `json:"entityId"`    // "" = <public url>/saml/metadata
	TenantID    string   `json:"tenantId"`    // "" = any tenant
	GroupMode   string   `json:"groupMode"`   // off | allow | deny
	Groups      []string `json:"groups"`      // Azure group object ids
	FromEnv     bool     `json:"fromEnv"`     // not saved: these came from the environment
}

type ssoStore struct {
	mu sync.RWMutex
	v  ssoSettings
}

// envSSO is what the environment says, used until an administrator saves settings.
func (s *server) envSSO() ssoSettings {
	v := ssoSettings{EntityID: "", TenantID: s.cfg.SAMLTenantID, GroupMode: "off", FromEnv: true}
	if s.cfg.SAMLEntityID != s.cfg.PublicURL.String()+"/saml/metadata" {
		v.EntityID = s.cfg.SAMLEntityID
	}
	switch {
	case s.cfg.SAMLMetadataURL != "":
		v.Source, v.MetadataURL = "url", s.cfg.SAMLMetadataURL
	case s.cfg.SAMLMetadataFile != "":
		v.Source = "file"
	}
	if len(s.cfg.AllowedGroups) > 0 {
		v.GroupMode, v.Groups = "allow", s.cfg.AllowedGroups
	}
	return v
}

// loadSSOSettings reads the saved settings, or falls back to the environment.
func (s *server) loadSSOSettings(ctx context.Context) {
	var raw []byte
	v := s.envSSO()
	if err := s.db.QueryRow(ctx, "SELECT value FROM app_settings WHERE key='sso'").Scan(&raw); err == nil {
		var saved ssoSettings
		if json.Unmarshal(raw, &saved) == nil {
			saved.FromEnv = false
			v = saved
		}
	}
	s.sso.mu.Lock()
	s.sso.v = v
	s.sso.mu.Unlock()
}

func (s *server) ssoSettings() ssoSettings {
	s.sso.mu.RLock()
	defer s.sso.mu.RUnlock()
	v := s.sso.v
	v.Groups = append([]string(nil), v.Groups...)
	return v
}

func (s *server) ssoConfigured() bool { return s.ssoSettings().Source != "" }

func (s *server) entityID() string {
	if v := s.ssoSettings(); v.EntityID != "" {
		return v.EntityID
	}
	return s.cfg.PublicURL.String() + "/saml/metadata"
}

// readIDPMetadata fetches or reads the metadata the settings point at.
func (s *server) readIDPMetadata(ctx context.Context, v ssoSettings) (raw []byte, source string, err error) {
	switch v.Source {
	case "url":
		u, perr := url.Parse(strings.TrimSpace(v.MetadataURL))
		if perr != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
			return nil, v.MetadataURL, fmt.Errorf("%q is not an http(s) address", v.MetadataURL)
		}
		fctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		md, ferr := samlsp.FetchMetadata(fctx, s.outboundClient(), *u)
		if ferr != nil {
			return nil, v.MetadataURL, ferr
		}
		raw, err = xmlMarshal(md)
		return raw, v.MetadataURL, err
	case "xml":
		return []byte(v.MetadataXML), "metadata XML entered by an administrator", nil
	case "file":
		raw, err = os.ReadFile(s.cfg.SAMLMetadataFile)
		return raw, s.cfg.SAMLMetadataFile, err
	}
	return nil, "", errors.New("single sign-on is not configured: enter the identity provider's metadata URL or XML under Tools > Users & sign-in")
}

// groupCheck applies the allow / deny list to the groups a sign-in carried.
func (s *server) groupCheck(groups []string) error {
	v := s.ssoSettings()
	if v.GroupMode != "allow" && v.GroupMode != "deny" {
		return nil
	}
	listed := false
	for _, g := range groups {
		for _, want := range v.Groups {
			if strings.EqualFold(strings.TrimSpace(g), strings.TrimSpace(want)) {
				listed = true
			}
		}
	}
	switch {
	case v.GroupMode == "allow" && !listed:
		return fmt.Errorf("you are not in a group allowed to use RoadMap Studio (the sign-in listed %d group(s); %d allowed)", len(groups), len(v.Groups))
	case v.GroupMode == "deny" && listed:
		return errors.New("you are in a group that has been denied access to RoadMap Studio")
	}
	return nil
}

// ---- administration API ------------------------------------------------------------

type metadataSummary struct {
	EntityID string    `json:"entityId"`
	SSOURL   string    `json:"ssoUrl"`
	Certs    []idpCert `json:"certificates"`
}

func summariseMetadata(raw []byte) (*metadataSummary, error) {
	md, err := samlsp.ParseMetadata(raw)
	if err != nil {
		return nil, fmt.Errorf("this is not SAML federation metadata: %v", err)
	}
	if len(md.IDPSSODescriptors) == 0 {
		return nil, errors.New("the metadata describes no identity provider (no IDPSSODescriptor)")
	}
	out := &metadataSummary{EntityID: md.EntityID, Certs: idpCerts(md)}
	for _, b := range md.IDPSSODescriptors[0].SingleSignOnServices {
		if b.Binding == saml.HTTPRedirectBinding {
			out.SSOURL = b.Location
		}
	}
	if out.SSOURL == "" {
		return nil, errors.New("the metadata has no HTTP-Redirect sign-in address")
	}
	return out, nil
}

func (s *server) readSettingsBody(w http.ResponseWriter, r *http.Request) (ssoSettings, bool) {
	var in ssoSettings
	if !readJSON(w, r, 2<<20, &in) {
		return in, false
	}
	in.FromEnv = false
	in.MetadataURL, in.MetadataXML = strings.TrimSpace(in.MetadataURL), strings.TrimSpace(in.MetadataXML)
	in.EntityID, in.TenantID = strings.TrimSpace(in.EntityID), strings.ToLower(strings.TrimSpace(in.TenantID))
	var groups []string
	for _, g := range in.Groups {
		if g = strings.TrimSpace(g); g != "" {
			groups = append(groups, g)
		}
	}
	in.Groups = groups
	if in.GroupMode != "allow" && in.GroupMode != "deny" {
		in.GroupMode = "off"
	}
	if in.GroupMode != "off" && len(in.Groups) == 0 {
		writeErr(w, http.StatusBadRequest, "Group access is on but no groups are listed. Enter the Azure group object ids, one per line, or turn it off.")
		return in, false
	}
	switch in.Source {
	case "url":
		if in.MetadataURL == "" {
			writeErr(w, http.StatusBadRequest, "Enter the App Federation Metadata Url from Azure.")
			return in, false
		}
	case "xml":
		if in.MetadataXML == "" {
			writeErr(w, http.StatusBadRequest, "Paste the Federation Metadata XML from Azure.")
			return in, false
		}
	case "file":
		if s.cfg.SAMLMetadataFile == "" {
			writeErr(w, http.StatusBadRequest, "No metadata file is configured on the server (RMS_SAML_METADATA_FILE).")
			return in, false
		}
	case "":
	default:
		writeErr(w, http.StatusBadRequest, "source must be url, xml or file")
		return in, false
	}
	return in, true
}

// handleSSOCheck reads the metadata the form points at and reports what it
// describes, without saving anything.
func (s *server) handleSSOCheck(w http.ResponseWriter, r *http.Request) {
	in, ok := s.readSettingsBody(w, r)
	if !ok {
		return
	}
	if in.Source == "" {
		writeErr(w, http.StatusBadRequest, "Choose where the metadata comes from first.")
		return
	}
	raw, source, err := s.readIDPMetadata(r.Context(), in)
	if err != nil {
		writeErr(w, http.StatusBadGateway, fmt.Sprintf("could not read %s: %v", source, err))
		return
	}
	sum, err := summariseMetadata(raw)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, sum)
}

// handleSSOSave stores the settings, tells every instance, and loads the metadata.
func (s *server) handleSSOSave(w http.ResponseWriter, r *http.Request) {
	in, ok := s.readSettingsBody(w, r)
	if !ok {
		return
	}
	if in.Source != "" {
		raw, source, err := s.readIDPMetadata(r.Context(), in)
		if err != nil {
			writeErr(w, http.StatusBadGateway, fmt.Sprintf("not saved - could not read %s: %v", source, err))
			return
		}
		if _, err := summariseMetadata(raw); err != nil {
			writeErr(w, http.StatusBadRequest, "not saved - "+err.Error())
			return
		}
	}
	raw, _ := json.Marshal(in)
	if _, err := s.db.Exec(r.Context(), `INSERT INTO app_settings (key, value, updated_by) VALUES ('sso', $1, $2)
		ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`, raw, currentUser(r).ID); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	log.Printf("SSO settings saved by %s (source %q, groups %s)", currentUser(r).Email, in.Source, in.GroupMode)
	s.db.Exec(r.Context(), "SELECT pg_notify('rms_settings', 'sso')")
	s.reloadSSO(r.Context())
	s.handleAdminSSO(w, r)
}

// reloadSSO re-reads the settings and the identity provider metadata (also
// run when another instance saves).
func (s *server) reloadSSO(ctx context.Context) {
	s.loadSSOSettings(ctx)
	if s.cfg.AuthMode != "saml" {
		return
	}
	if !s.ssoConfigured() {
		s.saml.mu.Lock()
		s.saml.sp, s.saml.lastErr = nil, ""
		s.saml.mu.Unlock()
		return
	}
	if err := s.loadIDPMetadata(ctx); err != nil {
		log.Printf("SAML: %v", err)
	}
}
