package main

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// config is read once from the environment. Every value has a safe default
// except the two that only the deployment can know: the public address and
// where the identity provider's metadata lives.
type config struct {
	PublicURL *url.URL // https://roadmap.example.com - what browsers and Azure use

	Listen         string // HTTPS when a certificate is installed, plain HTTP otherwise
	RedirectListen string // plain HTTP listener that only redirects to HTTPS ("" = off)
	HealthListen   string // loopback-only health endpoint for the container check

	DatabaseURL    string
	DBPasswordFile string
	DBWait         time.Duration

	AuthMode string // "saml" (production) or "dev" (test logins, never for real use)

	LocalAdmin bool // the local "admin" account may sign in (RMS_LOCAL_ADMIN, default on)

	SAMLMetadataURL  string
	SAMLMetadataFile string
	SAMLEntityID     string
	SAMLTenantID     string   // optional: refuse assertions from any other tenant
	AllowedGroups    []string // optional: only members of these groups may sign in
	AdminEmails      []string // these people are administrators
	OutboundProxy    string   // proxy for fetching the metadata URL ("" = direct)

	TLSDir      string
	TLSCertName string
	TLSKeyName  string

	SessionIdle time.Duration
	SessionMax  time.Duration
}

func env(key, def string) string {
	if v, ok := os.LookupEnv(key); ok {
		return strings.TrimSpace(v)
	}
	return def
}

func envList(key string) []string {
	var out []string
	for _, p := range strings.Split(env(key, ""), ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, strings.ToLower(p))
		}
	}
	return out
}

func envBool(key string, def bool) bool {
	switch strings.ToLower(env(key, "")) {
	case "on", "true", "yes", "1":
		return true
	case "off", "false", "no", "0":
		return false
	}
	return def
}

func envDuration(key string, def time.Duration, unit time.Duration) time.Duration {
	v := env(key, "")
	if v == "" {
		return def
	}
	n, err := strconv.ParseFloat(v, 64)
	if err != nil || n <= 0 {
		return def
	}
	return time.Duration(n * float64(unit))
}

func loadConfig() (*config, error) {
	c := &config{
		Listen:           env("RMS_LISTEN", ":8443"),
		RedirectListen:   env("RMS_REDIRECT_LISTEN", ":8080"),
		HealthListen:     env("RMS_HEALTH_LISTEN", "127.0.0.1:8079"),
		DatabaseURL:      env("RMS_DATABASE_URL", "postgres://roadmap@localhost:5432/roadmap?sslmode=disable"),
		DBPasswordFile:   env("RMS_DB_PASSWORD_FILE", ""),
		DBWait:           envDuration("RMS_DB_WAIT_SECONDS", 120*time.Second, time.Second),
		AuthMode:         strings.ToLower(env("RMS_AUTH_MODE", "saml")),
		LocalAdmin:       envBool("RMS_LOCAL_ADMIN", true),
		SAMLMetadataURL:  env("RMS_SAML_METADATA_URL", ""),
		SAMLMetadataFile: env("RMS_SAML_METADATA_FILE", ""),
		SAMLEntityID:     env("RMS_SAML_ENTITY_ID", ""),
		SAMLTenantID:     strings.ToLower(env("RMS_SAML_TENANT_ID", "")),
		AllowedGroups:    envList("RMS_SAML_ALLOWED_GROUPS"),
		AdminEmails:      envList("RMS_ADMIN_EMAILS"),
		OutboundProxy:    env("RMS_OUTBOUND_PROXY", ""),
		TLSDir:           env("RMS_TLS_DIR", "/certs"),
		TLSCertName:      env("RMS_TLS_CERT_NAME", "tls.crt"),
		TLSKeyName:       env("RMS_TLS_KEY_NAME", "tls.key"),
		SessionIdle:      envDuration("RMS_SESSION_IDLE_HOURS", 12*time.Hour, time.Hour),
		SessionMax:       envDuration("RMS_SESSION_MAX_DAYS", 7*24*time.Hour, 24*time.Hour),
	}

	pub := env("RMS_PUBLIC_URL", "")
	if pub == "" {
		return nil, fmt.Errorf("RMS_PUBLIC_URL is not set: give the address people open, for example https://roadmap.example.com " +
			"(Azure sends sign-ins back to <that address>/saml/acs)")
	}
	u, err := url.Parse(strings.TrimRight(pub, "/"))
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return nil, fmt.Errorf("RMS_PUBLIC_URL %q is not an http(s) address", pub)
	}
	c.PublicURL = u

	switch c.AuthMode {
	case "saml":
		// The metadata source may also be entered in the app by an administrator
		// and saved in the database, so nothing is required here.
	case "dev":
		// Test logins with no identity provider. Refused unless asked for twice,
		// so a copied env file can never turn it on by accident.
		if env("RMS_DEV_LOGIN_ACKNOWLEDGE", "") != "anyone-can-sign-in-as-anyone" {
			return nil, fmt.Errorf("RMS_AUTH_MODE=dev lets anyone sign in as anyone. It also needs " +
				"RMS_DEV_LOGIN_ACKNOWLEDGE=anyone-can-sign-in-as-anyone, and must never be used for real data")
		}
	default:
		return nil, fmt.Errorf("RMS_AUTH_MODE %q is not one of saml, dev", c.AuthMode)
	}
	if c.SAMLEntityID == "" {
		c.SAMLEntityID = c.PublicURL.String() + "/saml/metadata"
	}
	return c, nil
}

// ssoConfigured: single sign-on has somewhere to read the IdP metadata from.
func (c *config) ssoConfigured() bool { return c.SAMLMetadataURL != "" || c.SAMLMetadataFile != "" }

// secure reports whether cookies must be HTTPS-only.
func (c *config) secure() bool { return c.PublicURL.Scheme == "https" }

func (c *config) abs(path string) string { return c.PublicURL.String() + path }
