// RoadMap Studio (web) - swimlane roadmaps in the browser, shared and edited
// together in real time, signed in with Microsoft Entra ID.
//
//	roadmap                    serve (the default)
//	roadmap healthcheck        exit 0 when the server answers (container health check)
//	roadmap tls-init           make a self-signed certificate if none is installed
//	roadmap init-credentials   make the database password file on first start
//	roadmap reset-admin-password   the local administrator becomes admin/admin again
package main

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"os"
	"os/signal"
	"path"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

var appVersion = "2.0.0"

//go:embed ui
var uiFiles embed.FS

type server struct {
	cfg       *config
	db        *pgxpool.Pool
	cookieKey []byte
	saml      samlState
	hub       *hub
	stopping  chan struct{}
	ui        fs.FS
	etags     map[string]string

	localFails failures
	sso        ssoStore
}

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	cmd := "serve"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	var err error
	switch cmd {
	case "serve":
		err = serve()
	case "healthcheck":
		err = healthcheck()
	case "tls-init":
		err = tlsInit()
	case "init-credentials":
		err = initCredentials()
	case "reset-admin-password":
		err = resetAdminPassword()
	case "version":
		fmt.Println(appVersion)
	default:
		err = fmt.Errorf("unknown command %q (serve, healthcheck, tls-init, init-credentials, reset-admin-password, version)", cmd)
	}
	if err != nil {
		log.Printf("%s: %v", cmd, err)
		os.Exit(1)
	}
}

func serve() error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	db, err := connectDB(ctx, cfg)
	if err != nil {
		return err
	}
	defer db.Close()
	if err := migrate(ctx, db); err != nil {
		return fmt.Errorf("database migration: %w", err)
	}
	if cfg.LocalAdmin {
		if err := seedLocalAdmin(ctx, db); err != nil {
			return fmt.Errorf("local administrator: %w", err)
		}
	} else if _, err := db.Exec(ctx, "DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE password_hash <> '')"); err != nil {
		return fmt.Errorf("local administrator: %w", err) // off: its sessions end for good, not just while off
	}
	s := &server{cfg: cfg, db: db, stopping: make(chan struct{})}
	if s.cookieKey, err = sharedSecret(ctx, db, "cookie_key", func() ([]byte, error) { return randomBytes(32), nil }); err != nil {
		return err
	}
	s.loadSSOSettings(ctx)
	if !cfg.LocalAdmin && !s.ssoConfigured() {
		log.Printf("WARNING: single sign-on is not configured and RMS_LOCAL_ADMIN=off - nobody can sign in")
	}
	s.ui, _ = fs.Sub(uiFiles, "ui")
	s.etags = map[string]string{}
	fs.WalkDir(s.ui, ".", func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			b, _ := fs.ReadFile(s.ui, p)
			h := sha256.Sum256(b)
			s.etags[p] = `"` + hex.EncodeToString(h[:8]) + `"`
		}
		return nil
	})
	s.hub = newHub(s)
	go s.hub.listen(ctx)
	go s.hub.heartbeat(ctx)
	if cfg.AuthMode == "saml" && s.ssoConfigured() {
		go s.refreshSAML(ctx)
	} else if cfg.AuthMode == "saml" {
		log.Printf("single sign-on is not configured: only the local administrator can sign in, at /auth/local, and set it up under Tools > Users & sign-in")
	} else {
		log.Printf("WARNING: RMS_AUTH_MODE=dev - anyone can sign in as anyone. Never use this for real data.")
	}
	go func() {
		t := time.NewTicker(time.Hour)
		defer t.Stop()
		for {
			housekeeping(ctx, db)
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
		}
	}()

	handler := s.securityHeaders(s.routes())
	srv := &http.Server{Addr: cfg.Listen, Handler: handler, ReadHeaderTimeout: 15 * time.Second, IdleTimeout: 120 * time.Second}
	certs := newCertWatcher(cfg)
	errc := make(chan error, 3)
	if certs.available() {
		srv.TLSConfig = certs.tlsConfig()
		go func() { errc <- srv.ListenAndServeTLS("", "") }()
		log.Printf("RoadMap Studio %s serving HTTPS on %s as %s", appVersion, cfg.Listen, cfg.PublicURL)
		if cfg.RedirectListen != "" {
			redirect := &http.Server{Addr: cfg.RedirectListen, ReadHeaderTimeout: 10 * time.Second,
				Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					http.Redirect(w, r, cfg.PublicURL.String()+r.URL.RequestURI(), http.StatusMovedPermanently)
				})}
			go func() { errc <- redirect.ListenAndServe() }()
			defer redirect.Close()
		}
	} else {
		go func() { errc <- srv.ListenAndServe() }()
		log.Printf("RoadMap Studio %s serving plain HTTP on %s as %s (no certificate in %s)", appVersion, cfg.Listen, cfg.PublicURL, cfg.TLSDir)
	}
	health := &http.Server{Addr: cfg.HealthListen, ReadHeaderTimeout: 5 * time.Second,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { s.handleHealth(w, r) })}
	go func() { errc <- health.ListenAndServe() }()
	defer health.Close()

	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		log.Printf("stopping")
	}
	close(s.stopping) // ends the live streams so Shutdown does not wait on them
	sctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return srv.Shutdown(sctx)
}

func (s *server) routes() http.Handler {
	pub := http.NewServeMux()
	pub.HandleFunc("GET /healthz", s.handleHealth)
	pub.HandleFunc("GET /login", s.handleLogin)
	pub.HandleFunc("GET /saml/metadata", s.handleSPMetadata)
	pub.HandleFunc("GET /saml/login", s.handleSAMLLogin)
	pub.HandleFunc("POST /saml/acs", s.handleSAMLACS)
	pub.HandleFunc("GET /auth/logout", s.handleLogout)
	pub.HandleFunc("GET /auth/dev", s.handleDevLogin)
	pub.HandleFunc("POST /auth/dev", s.handleDevLogin)
	pub.HandleFunc("GET /auth/local", s.handleLocalLogin)
	pub.HandleFunc("POST /auth/local", s.handleLocalLogin)

	app := http.NewServeMux()
	app.HandleFunc("GET /api/me", s.handleMe)
	app.HandleFunc("PUT /api/me/settings", s.handleSaveSettings)
	app.HandleFunc("PUT /api/me/password", s.handleChangePassword)
	app.HandleFunc("GET /api/users", s.handleFindPeople)
	app.HandleFunc("GET /api/roadmaps", s.handleListRoadmaps)
	app.HandleFunc("POST /api/roadmaps", s.handleCreateRoadmap)
	app.HandleFunc("GET /api/roadmaps/{id}", s.handleGetRoadmap)
	app.HandleFunc("DELETE /api/roadmaps/{id}", s.handleDeleteRoadmap)
	app.HandleFunc("POST /api/roadmaps/{id}/ops", s.handleOps)
	app.HandleFunc("GET /api/roadmaps/{id}/events", s.handleEvents)
	app.HandleFunc("POST /api/roadmaps/{id}/presence", s.handlePresence)
	app.HandleFunc("GET /api/roadmaps/{id}/members", s.handleMembers)
	app.HandleFunc("PUT /api/roadmaps/{id}/members/{uid}", s.handleSetMember)
	app.HandleFunc("DELETE /api/roadmaps/{id}/members/{uid}", s.handleRemoveMember)
	app.HandleFunc("POST /api/roadmaps/{id}/owner", s.handleTransfer)
	app.HandleFunc("PUT /api/roadmaps/{id}/everyone", s.handleSetEveryone)
	app.HandleFunc("GET /api/roadmaps/{id}/comments", s.handleListComments)
	app.HandleFunc("POST /api/roadmaps/{id}/comments", s.handleAddComment)
	app.HandleFunc("PATCH /api/roadmaps/{id}/comments/{cid}", s.handleResolveComment)
	app.HandleFunc("DELETE /api/roadmaps/{id}/comments/{cid}", s.handleDeleteComment)
	app.HandleFunc("GET /api/roadmaps/{id}/activity", s.handleActivity)
	app.HandleFunc("GET /api/roadmaps/{id}/versions", s.handleListVersions)
	app.HandleFunc("POST /api/roadmaps/{id}/versions", s.handleSaveVersion)
	app.HandleFunc("GET /api/roadmaps/{id}/versions/{vid}", s.handleGetVersion)
	app.HandleFunc("DELETE /api/roadmaps/{id}/versions/{vid}", s.handleDeleteVersion)
	app.HandleFunc("GET /api/admin/users", s.requireAdmin(s.handleAdminUsers))
	app.HandleFunc("PATCH /api/admin/users/{uid}", s.requireAdmin(s.handleAdminUpdateUser))
	app.HandleFunc("GET /api/admin/sso", s.requireAdmin(s.handleAdminSSO))
	app.HandleFunc("POST /api/admin/sso/refresh", s.requireAdmin(s.handleAdminSSORefresh))
	app.HandleFunc("POST /api/admin/sso/check", s.requireAdmin(s.handleSSOCheck))
	app.HandleFunc("PUT /api/admin/sso/settings", s.requireAdmin(s.handleSSOSave))
	app.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { writeErr(w, http.StatusNotFound, "no such API") })
	// "/" for every method (refused inside): "GET /" next to "/api/" is an
	// ambiguous pair to Go's router and panics at start-up.
	app.HandleFunc("/", s.handleStatic)
	pub.Handle("/", s.requireUser(app))
	return pub
}

func (s *server) handleHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if err := s.db.Ping(ctx); err != nil {
		writeErr(w, http.StatusServiceUnavailable, "database: "+err.Error())
		return
	}
	writeJSON(w, map[string]string{"status": "ok", "version": appVersion})
}

func (s *server) handleStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if name == "" {
		name = "index.html"
	}
	data, err := fs.ReadFile(s.ui, name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if ct := mime.TypeByExtension(path.Ext(name)); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	if strings.HasSuffix(name, ".js") {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	}
	// Revalidate every time: a new release must reach browsers at once, and
	// an unchanged file costs a 304.
	w.Header().Set("Cache-Control", "no-cache")
	if tag := s.etags[name]; tag != "" {
		w.Header().Set("ETag", tag)
		if r.Header.Get("If-None-Match") == tag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
	}
	w.Write(data)
}

// securityHeaders: the UI loads nothing from anywhere else, runs no inline
// script, and must never be framed.
func (s *server) securityHeaders(next http.Handler) http.Handler {
	csp := "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
		"connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "same-origin")
		if s.cfg.secure() {
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
		next.ServeHTTP(w, r)
	})
}

func healthcheck() error {
	addr := env("RMS_HEALTH_LISTEN", "127.0.0.1:8079")
	c := &http.Client{Timeout: 4 * time.Second}
	resp, err := c.Get("http://" + addr + "/healthz")
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("health endpoint answered %s", resp.Status)
	}
	return nil
}
