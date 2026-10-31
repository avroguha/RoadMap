package main

// The local administrator: one account with a password, next to single
// sign-on, so the app can be set up (and rescued) when SSO is not working yet.
//
//   - Seeded at start-up as user "admin" with the password "admin", once: a
//     changed password is never put back by a restart.
//   - Stored as PBKDF2-SHA256 (600,000 rounds, random salt) - never the password.
//   - Failed sign-ins are rate-limited per address and for the account overall.
//   - While the password is still the default, every page shows a red warning
//     to that account.
//   - RMS_LOCAL_ADMIN=off refuses local sign-in entirely.
//   - `roadmap reset-admin-password` (docker exec) puts admin/admin back and
//     turns the account on again, for when the password is lost.

import (
	"context"
	"crypto/pbkdf2"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"html/template"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	localAdminUser       = "admin"
	localAdminDefaultPwd = "admin"
	localAdminExternalID = "local:admin"
	pbkdf2Rounds         = 600_000
	minPasswordLength    = 8
)

func hashPassword(pw string) (string, error) {
	salt := randomBytes(16)
	key, err := pbkdf2.Key(sha256.New, pw, salt, pbkdf2Rounds, 32)
	if err != nil {
		return "", err
	}
	enc := base64.RawStdEncoding
	return fmt.Sprintf("pbkdf2-sha256$%d$%s$%s", pbkdf2Rounds, enc.EncodeToString(salt), enc.EncodeToString(key)), nil
}

func verifyPassword(pw, stored string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2-sha256" {
		return false
	}
	rounds, err := strconv.Atoi(parts[1])
	if err != nil || rounds < 1 || rounds > 10_000_000 {
		return false
	}
	enc := base64.RawStdEncoding
	salt, err1 := enc.DecodeString(parts[2])
	want, err2 := enc.DecodeString(parts[3])
	if err1 != nil || err2 != nil || len(want) == 0 {
		return false
	}
	got, err := pbkdf2.Key(sha256.New, pw, salt, rounds, len(want))
	return err == nil && subtle.ConstantTimeCompare(got, want) == 1
}

// A hash nobody's password matches: checked when the account does not exist
// or is off, so a wrong user name takes as long as a wrong password. Made on
// first use: the healthcheck subcommand runs every 30 s and must stay cheap.
var decoyHash = sync.OnceValue(func() string {
	h, _ := hashPassword(base64.RawStdEncoding.EncodeToString(randomBytes(18)))
	return h
})

// seedLocalAdmin creates admin/admin if it has never existed. Under the
// migration lock, so several instances starting at once create it once.
func seedLocalAdmin(ctx context.Context, db *pgxpool.Pool) error {
	var exists bool
	if err := db.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM users WHERE external_id=$1)", localAdminExternalID).Scan(&exists); err != nil || exists {
		return err
	}
	conn, err := db.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", migrationLock); err != nil {
		return err
	}
	defer conn.Exec(context.Background(), "SELECT pg_advisory_unlock($1)", migrationLock)
	hash, err := hashPassword(localAdminDefaultPwd)
	if err != nil {
		return err
	}
	tag, err := conn.Exec(ctx, `INSERT INTO users (external_id, username, name, is_admin, password_hash, password_is_default)
		VALUES ($1, $2, 'Administrator', true, $3, true) ON CONFLICT (external_id) DO NOTHING`,
		localAdminExternalID, localAdminUser, hash)
	if err == nil && tag.RowsAffected() == 1 {
		log.Printf("local administrator %q created with the default password %q - sign in at /auth/local and change it", localAdminUser, localAdminDefaultPwd)
	}
	return err
}

// resetAdminPassword is `roadmap reset-admin-password`: admin/admin again,
// an administrator, turned on, and signed out everywhere.
func resetAdminPassword() error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	ctx := context.Background()
	db, err := connectDB(ctx, cfg)
	if err != nil {
		return err
	}
	defer db.Close()
	if err := migrate(ctx, db); err != nil {
		return err
	}
	if err := seedLocalAdmin(ctx, db); err != nil {
		return err
	}
	hash, err := hashPassword(localAdminDefaultPwd)
	if err != nil {
		return err
	}
	var uid string
	if err := db.QueryRow(ctx, `UPDATE users SET username=$2, password_hash=$3, password_is_default=true, password_changed_at=now(),
		is_admin=true, active=true WHERE external_id=$1 RETURNING id`, localAdminExternalID, localAdminUser, hash).Scan(&uid); err != nil {
		return err
	}
	db.Exec(ctx, "DELETE FROM sessions WHERE user_id=$1", uid)
	fmt.Printf("The local administrator is %s / %s again. Sign in at %s and change the password.\n", localAdminUser, localAdminDefaultPwd, cfg.abs("/auth/local"))
	if !cfg.LocalAdmin {
		fmt.Println("Note: RMS_LOCAL_ADMIN=off - local sign-in is refused until that is changed.")
	}
	return nil
}

// ---- rate limiting -------------------------------------------------------------

// failures counts recent failed sign-ins: 5 per address, and 30 for the
// account across all addresses, in any 15 minutes. In memory: a restart
// forgets, which is fine against guessing at 600,000 PBKDF2 rounds a try.
type failures struct {
	mu     sync.Mutex
	byAddr map[string][]time.Time
	all    []time.Time
}

const (
	failWindow  = 15 * time.Minute
	failPerAddr = 5
	failOverall = 30
)

func recent(ts []time.Time, now time.Time) []time.Time {
	keep := ts[:0]
	for _, t := range ts {
		if now.Sub(t) < failWindow {
			keep = append(keep, t)
		}
	}
	return keep
}

// blocked reports how long until this address may try again (0 = now).
func (f *failures) blocked(addr string) time.Duration {
	f.mu.Lock()
	defer f.mu.Unlock()
	now := time.Now()
	f.all = recent(f.all, now)
	if f.byAddr == nil {
		f.byAddr = map[string][]time.Time{}
	}
	mine := recent(f.byAddr[addr], now)
	if len(mine) == 0 {
		delete(f.byAddr, addr)
	} else {
		f.byAddr[addr] = mine
	}
	switch {
	case len(mine) >= failPerAddr:
		return failWindow - now.Sub(mine[len(mine)-failPerAddr])
	case len(f.all) >= failOverall:
		return failWindow - now.Sub(f.all[len(f.all)-failOverall])
	}
	return 0
}

func (f *failures) add(addr string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.byAddr == nil {
		f.byAddr = map[string][]time.Time{}
	}
	now := time.Now()
	f.byAddr[addr] = append(f.byAddr[addr], now)
	f.all = append(f.all, now)
}

func clientAddr(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// ---- sign-in page ----------------------------------------------------------------

func (s *server) handleLocalLogin(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.LocalAdmin {
		http.NotFound(w, r)
		return
	}
	ret := safeReturn(r.FormValue("return"))
	if r.Method != http.MethodPost {
		s.localLoginPage(w, http.StatusOK, ret, "", "")
		return
	}
	if o := r.Header.Get("Origin"); o != "" && o != "null" && !sameOrigin(o, s.cfg.PublicURL) && !sameOrigin(o, requestOrigin(r)) {
		http.Error(w, "cross-site sign-in refused", http.StatusForbidden)
		return
	}
	addr := clientAddr(r)
	username := strings.ToLower(strings.TrimSpace(r.FormValue("username")))
	if wait := s.localFails.blocked(addr); wait > 0 {
		log.Printf("local sign-in: refused %q from %s - too many failed attempts", username, addr)
		s.localLoginPage(w, http.StatusTooManyRequests, ret, username,
			fmt.Sprintf("Too many failed attempts. Try again in %d minute(s).", int(wait.Minutes())+1))
		return
	}
	var uid, hash string
	var active bool
	err := s.db.QueryRow(r.Context(), "SELECT id, password_hash, active FROM users WHERE username=$1 AND password_hash <> ''", username).Scan(&uid, &hash, &active)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		s.signinError(w, r, http.StatusInternalServerError, "Sign-in failed", err.Error())
		return
	}
	if err != nil || !active {
		hash = decoyHash()
	}
	if !verifyPassword(r.FormValue("password"), hash) || err != nil || !active {
		s.localFails.add(addr)
		log.Printf("local sign-in: failed for %q from %s", username, addr)
		s.localLoginPage(w, http.StatusUnauthorized, ret, username, "That user name and password do not match.")
		return
	}
	if err := s.startSession(r.Context(), w, uid); err != nil {
		s.signinError(w, r, http.StatusInternalServerError, "Sign-in failed", err.Error())
		return
	}
	s.db.Exec(r.Context(), "UPDATE users SET last_login=now() WHERE id=$1", uid)
	log.Printf("signed in: local account %q from %s", username, addr)
	http.Redirect(w, r, ret, http.StatusSeeOther)
}

func (s *server) localLoginPage(w http.ResponseWriter, status int, ret, username, problem string) {
	esc := template.HTMLEscapeString
	body := `<form method="post" action="/auth/local"><input type="hidden" name="return" value="` + esc(ret) + `">` +
		`<label for="u">User name</label><input id="u" name="username" autocomplete="username" autofocus value="` + esc(username) + `">` +
		`<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password">` +
		`<button class="btn" type="submit">Sign in</button></form>`
	lines := []string{"For setting up and looking after RoadMap Studio. Everyone else signs in with their Microsoft account."}
	if s.cfg.AuthMode == "saml" {
		if s.ssoConfigured() {
			body += `<a class="alt" href="/saml/login?return=` + url.QueryEscape(ret) + `">Sign in with Microsoft instead</a>`
		} else {
			lines = append(lines, "Single sign-on is not configured yet, so this is the only way in. Set it up under Tools > Users & sign-in.")
		}
	}
	renderPage(w, status, page{Title: "Administrator sign-in", Warn: problem, Lines: lines, Body: template.HTML(body)})
}

// ---- changing the password ------------------------------------------------------

func (s *server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r)
	if !u.Local {
		writeErr(w, http.StatusBadRequest, "Your password is managed by your organisation's single sign-on, not by RoadMap Studio.")
		return
	}
	var in struct {
		Current string `json:"current"`
		Next    string `json:"next"`
	}
	if !readJSON(w, r, 4096, &in) {
		return
	}
	addr := clientAddr(r)
	if wait := s.localFails.blocked(addr); wait > 0 {
		writeErr(w, http.StatusTooManyRequests, fmt.Sprintf("Too many failed attempts. Try again in %d minute(s).", int(wait.Minutes())+1))
		return
	}
	var hash, username string
	if err := s.db.QueryRow(r.Context(), "SELECT password_hash, coalesce(username, '') FROM users WHERE id=$1", u.ID).Scan(&hash, &username); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !verifyPassword(in.Current, hash) {
		s.localFails.add(addr)
		writeErr(w, http.StatusForbidden, "The current password is not right.")
		return
	}
	switch {
	case len([]rune(in.Next)) < minPasswordLength:
		writeErr(w, http.StatusBadRequest, fmt.Sprintf("The new password needs at least %d characters.", minPasswordLength))
		return
	case in.Next == in.Current:
		writeErr(w, http.StatusBadRequest, "The new password is the same as the current one.")
		return
	case strings.EqualFold(in.Next, localAdminDefaultPwd) || strings.EqualFold(in.Next, username):
		writeErr(w, http.StatusBadRequest, "The new password cannot be the user name or the default password.")
		return
	}
	next, err := hashPassword(in.Next)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if _, err := s.db.Exec(r.Context(), `UPDATE users SET password_hash=$2, password_is_default=false, password_changed_at=now() WHERE id=$1`, u.ID, next); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Signed out everywhere else: whoever knew the old password is out.
	if c, err := r.Cookie(sessionCookie); err == nil {
		s.db.Exec(r.Context(), "DELETE FROM sessions WHERE user_id=$1 AND token_hash <> $2", u.ID, hashToken(c.Value))
	}
	log.Printf("local account %q changed its password", username)
	writeJSON(w, map[string]bool{"ok": true})
}
