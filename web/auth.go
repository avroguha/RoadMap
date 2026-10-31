package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const sessionCookie = "rms_session"

type user struct {
	ID       string `json:"id"`
	Email    string `json:"email"`
	Name     string `json:"name"`
	IsAdmin  bool   `json:"isAdmin"`
	Initials string `json:"initials"`
	Color    string `json:"color"`
	// The local administrator account (password sign-in), and whether its
	// password is still the default one.
	Local           bool `json:"local,omitempty"`
	DefaultPassword bool `json:"defaultPassword,omitempty"`
}

type userKey struct{}

func currentUser(r *http.Request) *user {
	u, _ := r.Context().Value(userKey{}).(*user)
	return u
}

var avatarColors = []string{"#2f6fed", "#e0477a", "#2aa876", "#f28b30", "#8e5bd9", "#15a3b8", "#c9a227", "#d8434e", "#5b6b8c", "#0e7490"}

// decorate fills in what the browser shows for a person: initials and a
// stable colour, so everyone sees the same colour for the same colleague.
func (u *user) decorate() *user {
	name := strings.TrimSpace(u.Name)
	if name == "" {
		name = u.Email
	}
	parts := strings.FieldsFunc(name, func(r rune) bool { return r == ' ' || r == '.' || r == '@' || r == '_' })
	switch {
	case len(parts) >= 2:
		u.Initials = strings.ToUpper(string([]rune(parts[0])[:1]) + string([]rune(parts[len(parts)-1])[:1]))
	case len(parts) == 1:
		r := []rune(parts[0])
		u.Initials = strings.ToUpper(string(r[:min(2, len(r))]))
	default:
		u.Initials = "?"
	}
	h := sha256.Sum256([]byte(u.ID))
	u.Color = avatarColors[int(h[0])%len(avatarColors)]
	return u
}

func hashToken(tok string) []byte {
	h := sha256.Sum256([]byte(tok))
	return h[:]
}

func (s *server) startSession(ctx context.Context, w http.ResponseWriter, userID string) error {
	tok := base64.RawURLEncoding.EncodeToString(randomBytes(32))
	_, err := s.db.Exec(ctx, `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
		hashToken(tok), userID, time.Now().Add(s.cfg.SessionMax))
	if err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: tok, Path: "/", HttpOnly: true,
		Secure: s.cfg.secure(), SameSite: http.SameSiteLaxMode, Expires: time.Now().Add(s.cfg.SessionMax)})
	return nil
}

func (s *server) endSession(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		s.db.Exec(r.Context(), "DELETE FROM sessions WHERE token_hash=$1", hashToken(c.Value))
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: s.cfg.secure(), SameSite: http.SameSiteLaxMode})
}

// sessionUser returns the signed-in person, or nil.
func (s *server) sessionUser(r *http.Request) *user {
	c, err := r.Cookie(sessionCookie)
	if err != nil || c.Value == "" {
		return nil
	}
	var u user
	var lastSeen time.Time
	h := hashToken(c.Value)
	err = s.db.QueryRow(r.Context(), `
		SELECT u.id, u.email, u.name, u.is_admin, u.password_hash <> '', u.password_is_default, s.last_seen
		FROM sessions s JOIN users u ON u.id = s.user_id
		WHERE s.token_hash=$1 AND s.expires_at > now() AND s.last_seen > now() - $2::interval AND u.active`,
		h, fmt.Sprintf("%d seconds", int(s.cfg.SessionIdle.Seconds()))).Scan(&u.ID, &u.Email, &u.Name, &u.IsAdmin, &u.Local, &u.DefaultPassword, &lastSeen)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) && r.Context().Err() == nil {
			log.Printf("session lookup: %v", err)
		}
		return nil
	}
	if u.Local && !s.cfg.LocalAdmin {
		return nil // RMS_LOCAL_ADMIN=off ends sessions it opened earlier too
	}
	if time.Since(lastSeen) > 5*time.Minute {
		s.db.Exec(r.Context(), "UPDATE sessions SET last_seen=now() WHERE token_hash=$1", h)
	}
	return u.decorate()
}

// requireUser guards everything except sign-in itself and the health check.
// An API call without a session gets 401 (the page shows "signed out"); a
// page load is sent to sign in and brought back afterwards.
func (s *server) requireUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u := s.sessionUser(r)
		api := strings.HasPrefix(r.URL.Path, "/api/")
		if u == nil {
			if api {
				writeErr(w, http.StatusUnauthorized, "You are signed out. Reload the page to sign in again.")
				return
			}
			http.Redirect(w, r, "/login?return="+url.QueryEscape(safeReturn(r.URL.RequestURI())), http.StatusFound)
			return
		}
		// Cross-site request forgery: every change must carry a header a form
		// on another site cannot set, and must not come from another origin.
		if api && r.Method != http.MethodGet && r.Method != http.MethodHead {
			if r.Header.Get("X-RMS") != "1" {
				writeErr(w, http.StatusForbidden, "missing X-RMS header")
				return
			}
			if o := r.Header.Get("Origin"); o != "" && o != "null" && !sameOrigin(o, s.cfg.PublicURL) && !sameOrigin(o, requestOrigin(r)) {
				writeErr(w, http.StatusForbidden, "request from another site refused")
				return
			}
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userKey{}, u)))
	})
}

func requestOrigin(r *http.Request) *url.URL {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return &url.URL{Scheme: scheme, Host: r.Host}
}

func sameOrigin(origin string, u *url.URL) bool {
	o, err := url.Parse(origin)
	return err == nil && strings.EqualFold(o.Scheme, u.Scheme) && strings.EqualFold(o.Host, u.Host)
}

// safeReturn keeps a post-sign-in redirect on this site.
func safeReturn(p string) string {
	if p == "" || !strings.HasPrefix(p, "/") || strings.HasPrefix(p, "//") || strings.HasPrefix(p, "/\\") ||
		strings.HasPrefix(p, "/login") || strings.HasPrefix(p, "/api/") || strings.HasPrefix(p, "/saml/") || strings.HasPrefix(p, "/auth/") {
		return "/"
	}
	return p
}

// ---- signed cookies (short-lived state that must survive a round trip to
// the identity provider and work on whichever instance receives it) --------

func (s *server) sign(v any, ttl time.Duration) string {
	body, _ := json.Marshal(map[string]any{"v": v, "exp": time.Now().Add(ttl).Unix()})
	b := base64.RawURLEncoding.EncodeToString(body)
	m := hmac.New(sha256.New, s.cookieKey)
	m.Write([]byte(b))
	return b + "." + base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func (s *server) unsign(tok string, into any) bool {
	b, sig, ok := strings.Cut(tok, ".")
	if !ok {
		return false
	}
	m := hmac.New(sha256.New, s.cookieKey)
	m.Write([]byte(b))
	want := m.Sum(nil)
	got, err := base64.RawURLEncoding.DecodeString(sig)
	if err != nil || !hmac.Equal(got, want) {
		return false
	}
	raw, err := base64.RawURLEncoding.DecodeString(b)
	if err != nil {
		return false
	}
	var env struct {
		V   json.RawMessage `json:"v"`
		Exp int64           `json:"exp"`
	}
	if json.Unmarshal(raw, &env) != nil || time.Now().Unix() > env.Exp {
		return false
	}
	return json.Unmarshal(env.V, into) == nil
}

// ---- provisioning -----------------------------------------------------------

type identity struct {
	ExternalID string
	Email      string
	Name       string
	Given      string
	Family     string
	Groups     []string
}

// provision creates the person on their first sign-in and refreshes their
// name and address on every later one.
func (s *server) provision(ctx context.Context, id identity) (string, error) {
	if id.ExternalID == "" {
		return "", errors.New("the sign-in carried no user identifier")
	}
	if id.ExternalID != localAdminExternalID {
		if err := s.groupCheck(id.Groups); err != nil {
			return "", err
		}
	}
	admin := false
	for _, a := range s.cfg.AdminEmails {
		if strings.EqualFold(a, id.Email) {
			admin = true
		}
	}
	var uid string
	var active bool
	err := s.db.QueryRow(ctx, `
		INSERT INTO users (external_id, email, name, given_name, family_name, is_admin, last_login)
		VALUES ($1, $2, $3, $4, $5, $6, now())
		ON CONFLICT (external_id) DO UPDATE SET
			email = EXCLUDED.email, name = EXCLUDED.name,
			given_name = EXCLUDED.given_name, family_name = EXCLUDED.family_name,
			is_admin = users.is_admin OR EXCLUDED.is_admin, last_login = now()
		RETURNING id, active`,
		id.ExternalID, id.Email, id.Name, id.Given, id.Family, admin).Scan(&uid, &active)
	if err != nil {
		return "", err
	}
	if !active {
		return "", fmt.Errorf("the account %s has been turned off by an administrator of RoadMap Studio", id.Email)
	}
	return uid, nil
}
