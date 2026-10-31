package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// ---- the signed-in person -------------------------------------------------------

func (s *server) handleMe(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r)
	var settings json.RawMessage
	if err := s.db.QueryRow(r.Context(), "SELECT settings FROM users WHERE id=$1", u.ID).Scan(&settings); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, map[string]any{
		"user": u, "settings": settings, "version": appVersion, "authMode": s.cfg.AuthMode,
		"mode": "web", "native": false, "browser": false,
	})
}

func (s *server) handleSaveSettings(w http.ResponseWriter, r *http.Request) {
	var v map[string]any
	if !readJSON(w, r, 256<<10, &v) {
		return
	}
	raw, _ := json.Marshal(v)
	if _, err := s.db.Exec(r.Context(), "UPDATE users SET settings=$2 WHERE id=$1", currentUser(r).ID, raw); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// handleFindPeople is the picker in the Share dialog. Everyone who has ever
// signed in can be found; nobody can be shared with before their first
// sign-in, because until then they do not exist here.
func (s *server) handleFindPeople(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(q) > 100 {
		q = q[:100]
	}
	like := "%" + strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(strings.ToLower(q)) + "%"
	rows, err := s.db.Query(r.Context(), `SELECT id, name, email FROM users
		WHERE active AND id <> $1 AND (lower(name) LIKE $2 OR lower(email) LIKE $2)
		ORDER BY name LIMIT 20`, currentUser(r).ID, like)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer rows.Close()
	out := []personRef{}
	for rows.Next() {
		var id, name, email string
		if rows.Scan(&id, &name, &email) == nil {
			out = append(out, ref(id, name, email, ""))
		}
	}
	writeJSON(w, out)
}

// ---- administration -------------------------------------------------------------

func (s *server) requireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !currentUser(r).IsAdmin {
			writeErr(w, http.StatusForbidden, "Only RoadMap Studio administrators can do that.")
			return
		}
		next(w, r)
	}
}

func (s *server) handleAdminUsers(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.Query(r.Context(), `SELECT u.id, u.name, u.email, u.is_admin, u.active, u.created_at, u.last_login,
		(SELECT count(*) FROM roadmaps WHERE owner_id = u.id),
		(SELECT count(*) FROM roadmap_members WHERE user_id = u.id)
		FROM users u ORDER BY u.name`)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer rows.Close()
	type row struct {
		personRef
		IsAdmin   bool       `json:"isAdmin"`
		Active    bool       `json:"active"`
		Created   time.Time  `json:"created"`
		LastLogin *time.Time `json:"lastLogin"`
		Owns      int        `json:"owns"`
		SharedIn  int        `json:"sharedIn"`
	}
	out := []row{}
	for rows.Next() {
		var x row
		var id, name, email string
		if rows.Scan(&id, &name, &email, &x.IsAdmin, &x.Active, &x.Created, &x.LastLogin, &x.Owns, &x.SharedIn) == nil {
			x.personRef = ref(id, name, email, "")
			out = append(out, x)
		}
	}
	writeJSON(w, out)
}

func (s *server) handleAdminUpdateUser(w http.ResponseWriter, r *http.Request) {
	uid := r.PathValue("uid")
	var in struct {
		Active     *bool  `json:"active"`
		IsAdmin    *bool  `json:"isAdmin"`
		TransferTo string `json:"transferTo"` // give all their roadmaps to someone
	}
	if !readJSON(w, r, 1024, &in) {
		return
	}
	me := currentUser(r).ID
	if uid == me && ((in.Active != nil && !*in.Active) || (in.IsAdmin != nil && !*in.IsAdmin)) {
		writeErr(w, http.StatusBadRequest, "You cannot turn off your own account or your own administrator rights.")
		return
	}
	if in.Active != nil {
		s.db.Exec(r.Context(), "UPDATE users SET active=$2 WHERE id=$1", uid, *in.Active)
		if !*in.Active {
			s.db.Exec(r.Context(), "DELETE FROM sessions WHERE user_id=$1", uid)
		}
	}
	if in.IsAdmin != nil {
		s.db.Exec(r.Context(), "UPDATE users SET is_admin=$2 WHERE id=$1", uid, *in.IsAdmin)
	}
	if in.TransferTo != "" {
		rows, err := s.db.Query(r.Context(), "SELECT id FROM roadmaps WHERE owner_id=$1", uid)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		var ids []string
		for rows.Next() {
			var id string
			if rows.Scan(&id) == nil {
				ids = append(ids, id)
			}
		}
		rows.Close()
		for _, rid := range ids {
			if err := s.transferOwnership(r.Context(), rid, uid, in.TransferTo); err != nil {
				writeErr(w, http.StatusBadRequest, err.Error())
				return
			}
			s.hub.notifyAccess(r.Context(), rid, in.TransferTo, "owner")
		}
	}
	s.handleAdminUsers(w, r)
}

func (s *server) handleAdminSSO(w http.ResponseWriter, r *http.Request) {
	st := &s.saml
	st.mu.RLock()
	defer st.mu.RUnlock()
	writeJSON(w, map[string]any{
		"mode":           s.cfg.AuthMode,
		"entityId":       s.entityID(),
		"acsUrl":         s.cfg.abs("/saml/acs"),
		"metadataUrl":    s.cfg.abs("/saml/metadata"),
		"signOnUrl":      s.cfg.abs("/login"),
		"source":         st.source,
		"loadedAt":       st.loadedAt,
		"idpEntityId":    st.idpEntity,
		"certificates":   st.certs,
		"lastError":      st.lastErr,
		"lastAttempt":    st.lastAttempt,
		"configured":     s.ssoConfigured(),
		"localAdmin":     s.cfg.LocalAdmin,
		"settings":       s.ssoSettings(),
		"fileConfigured": s.cfg.SAMLMetadataFile != "",
	})
}

func (s *server) handleAdminSSORefresh(w http.ResponseWriter, r *http.Request) {
	if s.cfg.AuthMode != "saml" {
		writeErr(w, http.StatusBadRequest, "single sign-on is not in use (RMS_AUTH_MODE=dev)")
		return
	}
	if !s.ssoConfigured() {
		writeErr(w, http.StatusBadRequest, "single sign-on is not configured yet")
		return
	}
	if err := s.loadIDPMetadata(r.Context()); err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	s.handleAdminSSO(w, r)
}
