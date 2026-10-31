package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	maxDocBytes      = 16 << 20
	autoVersionEvery = 10 * time.Minute
)

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func readJSON(w http.ResponseWriter, r *http.Request, limit int64, into any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit)).Decode(into); err != nil {
		writeErr(w, http.StatusBadRequest, "request body: "+err.Error())
		return false
	}
	return true
}

func validUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range s {
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			if !strings.ContainsRune("0123456789abcdefABCDEF", c) {
				return false
			}
		}
	}
	return true
}

func newUUID() string {
	b := randomBytes(16)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// roleFor is "owner", "editor", "commenter", "viewer", or "" (no access or
// no roadmap). A person without a membership gets the role the owner gave
// everyone, if any.
func (s *server) roleFor(ctx context.Context, rid, uid string) (string, error) {
	if !validUUID(rid) {
		return "", nil
	}
	var role *string
	err := s.db.QueryRow(ctx, `SELECT CASE WHEN r.owner_id = $2 THEN 'owner' ELSE coalesce(m.role, nullif(r.everyone_role, '')) END
		FROM roadmaps r LEFT JOIN roadmap_members m ON m.roadmap_id = r.id AND m.user_id = $2
		WHERE r.id = $1`, rid, uid).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) || role == nil {
		return "", nil
	}
	return *role, err
}

// access checks the caller's role against the least one the action needs.
func (s *server) access(w http.ResponseWriter, r *http.Request, need string) (string, bool) {
	role, err := s.roleFor(r.Context(), r.PathValue("id"), currentUser(r).ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return "", false
	}
	rank := map[string]int{"": 0, "viewer": 1, "commenter": 2, "editor": 3, "owner": 4}
	if role == "" {
		writeErr(w, http.StatusNotFound, "This roadmap does not exist or has not been shared with you.")
		return "", false
	}
	if rank[role] < rank[need] {
		msg := map[string]string{
			"commenter": "You can view this roadmap but not comment on it. Ask its owner for Commenter access.",
			"editor":    "You can view this roadmap but not change it. Ask its owner for Editor access.",
			"owner":     "Only the owner of this roadmap can do that.",
		}[need]
		writeErr(w, http.StatusForbidden, msg)
		return role, false
	}
	return role, true
}

type personRef struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Email    string `json:"email"`
	Role     string `json:"role,omitempty"`
	Initials string `json:"initials"`
	Color    string `json:"color"`
}

func ref(id, name, email, role string) personRef {
	u := (&user{ID: id, Name: name, Email: email}).decorate()
	return personRef{ID: id, Name: name, Email: email, Role: role, Initials: u.Initials, Color: u.Color}
}

// ---- list, create, open, delete --------------------------------------------

func (s *server) handleListRoadmaps(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r)
	rows, err := s.db.Query(r.Context(), `
		SELECT r.id, r.name, r.owner_id, o.name, o.email,
		       CASE WHEN r.owner_id = $1 THEN 'owner' ELSE coalesce(m.role, r.everyone_role) END,
		       (SELECT count(*) FROM roadmap_members x WHERE x.roadmap_id = r.id),
		       r.updated_at, r.rev, r.everyone_role, m.user_id IS NOT NULL
		FROM roadmaps r
		JOIN users o ON o.id = r.owner_id
		LEFT JOIN roadmap_members m ON m.roadmap_id = r.id AND m.user_id = $1
		WHERE r.owner_id = $1 OR m.user_id IS NOT NULL OR r.everyone_role <> ''
		ORDER BY r.created_at`, u.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer rows.Close()
	type item struct {
		ID        string    `json:"id"`
		Name      string    `json:"name"`
		Owner     personRef `json:"owner"`
		Role      string    `json:"role"`
		Members   int       `json:"members"`
		UpdatedAt time.Time `json:"updatedAt"`
		Rev       int64     `json:"rev"`
		Everyone  string    `json:"everyone"` // role everyone in the organisation has ("" = not shared that way)
		Via       string    `json:"via"`      // owner | member | everyone
	}
	out := []item{}
	for rows.Next() {
		var it item
		var oid, oname, oemail string
		var member bool
		if err := rows.Scan(&it.ID, &it.Name, &oid, &oname, &oemail, &it.Role, &it.Members, &it.UpdatedAt, &it.Rev, &it.Everyone, &member); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		it.Owner = ref(oid, oname, oemail, "owner")
		it.Via = map[bool]string{true: "member", false: "everyone"}[member]
		if oid == u.ID {
			it.Via = "owner"
		}
		out = append(out, it)
	}
	writeJSON(w, out)
}

// prepareDoc checks a whole roadmap sent by a browser and gives it its id.
func prepareDoc(raw json.RawMessage, id string) ([]byte, string, error) {
	var doc map[string]any
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	if err := dec.Decode(&doc); err != nil || doc == nil {
		return nil, "", errors.New("the roadmap is not a JSON object")
	}
	if l, ok := doc["lanes"]; ok {
		if _, ok := l.([]any); !ok {
			return nil, "", errors.New("lanes must be a list")
		}
	}
	for k := range doc {
		if strings.HasPrefix(k, "_") {
			delete(doc, k) // client-only state
		}
	}
	doc["id"] = id
	name, _ := doc["name"].(string)
	if strings.TrimSpace(name) == "" {
		name = "Untitled roadmap"
		doc["name"] = name
	}
	out, err := json.Marshal(doc)
	return out, name, err
}

func (s *server) handleCreateRoadmap(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r)
	var in struct {
		Doc      json.RawMessage `json:"doc"`
		Versions []struct {
			Label string          `json:"label"`
			Auto  bool            `json:"auto"`
			TS    int64           `json:"ts"`
			Doc   json.RawMessage `json:"roadmap"`
		} `json:"versions"` // carried over when importing a desktop backup
	}
	if !readJSON(w, r, maxDocBytes*4, &in) {
		return
	}
	id := newUUID()
	doc, name, err := prepareDoc(in.Doc, id)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer tx.Rollback(r.Context())
	if _, err := tx.Exec(r.Context(), `INSERT INTO roadmaps (id, owner_id, name, doc, updated_by) VALUES ($1, $2, $3, $4, $2)`,
		id, u.ID, name, doc); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	for _, v := range in.Versions {
		vdoc, _, err := prepareDoc(v.Doc, id)
		if err != nil {
			continue
		}
		at := time.Now()
		if v.TS > 0 {
			at = time.UnixMilli(v.TS)
		}
		_, items := docSummary(vdoc)
		tx.Exec(r.Context(), `INSERT INTO roadmap_versions (roadmap_id, rev, label, auto, items, doc, created_at, created_by)
			VALUES ($1, 0, $2, $3, $4, $5, $6, $7)`, id, v.Label, v.Auto, items, vdoc, at, u.ID)
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, map[string]any{"id": id, "rev": 0, "doc": json.RawMessage(doc)})
}

func (s *server) handleGetRoadmap(w http.ResponseWriter, r *http.Request) {
	role, ok := s.access(w, r, "viewer")
	if !ok {
		return
	}
	var doc []byte
	var rev int64
	var everyone string
	if err := s.db.QueryRow(r.Context(), "SELECT doc, rev, everyone_role FROM roadmaps WHERE id=$1", r.PathValue("id")).Scan(&doc, &rev, &everyone); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	members, err := s.members(r.Context(), r.PathValue("id"))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, map[string]any{"doc": json.RawMessage(doc), "rev": rev, "role": role, "members": members, "everyone": everyone})
}

func (s *server) handleDeleteRoadmap(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.access(w, r, "owner"); !ok {
		return
	}
	rid := r.PathValue("id")
	if _, err := s.db.Exec(r.Context(), "DELETE FROM roadmaps WHERE id=$1", rid); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.hub.notifyAccess(r.Context(), rid, "*", "")
	writeJSON(w, map[string]bool{"ok": true})
}

// ---- edits -------------------------------------------------------------------

func (s *server) handleOps(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.access(w, r, "editor"); !ok {
		return
	}
	u := currentUser(r)
	rid := r.PathValue("id")
	var in struct {
		BatchID string `json:"batchId"`
		Ops     []op   `json:"ops"`
	}
	if !readJSON(w, r, maxDocBytes, &in) {
		return
	}
	if in.BatchID == "" || len(in.BatchID) > 80 {
		writeErr(w, http.StatusBadRequest, "batchId missing")
		return
	}
	if err := validateOps(in.Ops); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	rev, err := s.applyBatch(r.Context(), rid, u.ID, in.BatchID, in.Ops)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, map[string]any{"rev": rev})
}

// applyBatch applies one batch under a row lock, so batches on a roadmap are
// strictly ordered by rev. A batch id seen before is not applied twice.
func (s *server) applyBatch(ctx context.Context, rid, uid, batchID string, ops []op) (int64, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	var doc []byte
	var rev int64
	if err := tx.QueryRow(ctx, "SELECT doc, rev FROM roadmaps WHERE id=$1 FOR UPDATE", rid).Scan(&doc, &rev); err != nil {
		return 0, err
	}
	var seen int64
	if err := tx.QueryRow(ctx, "SELECT rev FROM roadmap_ops WHERE roadmap_id=$1 AND batch_id=$2", rid, batchID).Scan(&seen); err == nil {
		return seen, nil // a resend after a lost response
	}
	summary := describeOps(doc, ops)
	next, err := applyOps(doc, ops)
	if err != nil {
		return 0, err
	}
	if len(next) > maxDocBytes {
		return 0, fmt.Errorf("the roadmap would be larger than %d MB", maxDocBytes>>20)
	}
	opsJSON, _ := json.Marshal(ops)
	rev++
	name, items := docSummary(next)
	if _, err := tx.Exec(ctx, `UPDATE roadmaps SET doc=$2, rev=$3, name=$4, updated_at=now(), updated_by=$5 WHERE id=$1`,
		rid, next, rev, name, uid); err != nil {
		return 0, err
	}
	summaryJSON, _ := json.Marshal(summary)
	if _, err := tx.Exec(ctx, `INSERT INTO roadmap_ops (roadmap_id, rev, batch_id, user_id, ops, summary) VALUES ($1, $2, $3, $4, $5, $6)`,
		rid, rev, batchID, uid, opsJSON, summaryJSON); err != nil {
		return 0, err
	}
	// An automatic version every ten minutes of activity.
	var last *time.Time
	tx.QueryRow(ctx, "SELECT max(created_at) FROM roadmap_versions WHERE roadmap_id=$1 AND auto", rid).Scan(&last)
	if last == nil || time.Since(*last) > autoVersionEvery {
		if _, err := tx.Exec(ctx, `INSERT INTO roadmap_versions (roadmap_id, rev, auto, items, doc, created_by) VALUES ($1, $2, true, $3, $4, $5)`,
			rid, rev, items, next, uid); err != nil {
			return 0, err
		}
	}
	if _, err := tx.Exec(ctx, "SELECT pg_notify('rms_ops', $1)", rid+":"+strconv.FormatInt(rev, 10)); err != nil {
		return 0, err
	}
	return rev, tx.Commit(ctx)
}

// personByID is a small reference for the history (name and email as of now).
func (s *server) personByID(ctx context.Context, uid string) personRef {
	var name, email string
	s.db.QueryRow(ctx, "SELECT name, email FROM users WHERE id=$1", uid).Scan(&name, &email)
	return ref(uid, name, email, "")
}

// ---- sharing -------------------------------------------------------------------

func (s *server) members(ctx context.Context, rid string) ([]personRef, error) {
	rows, err := s.db.Query(ctx, `
		SELECT u.id, u.name, u.email, 'owner' FROM roadmaps r JOIN users u ON u.id = r.owner_id WHERE r.id = $1
		UNION ALL
		SELECT u.id, u.name, u.email, m.role FROM roadmap_members m JOIN users u ON u.id = m.user_id WHERE m.roadmap_id = $1
		ORDER BY 4 DESC, 2`, rid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []personRef{}
	for rows.Next() {
		var id, name, email, role string
		if err := rows.Scan(&id, &name, &email, &role); err != nil {
			return nil, err
		}
		out = append(out, ref(id, name, email, role))
	}
	return out, rows.Err()
}

func (s *server) handleMembers(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.access(w, r, "viewer"); !ok {
		return
	}
	m, err := s.members(r.Context(), r.PathValue("id"))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, m)
}

func (s *server) handleSetMember(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.access(w, r, "owner"); !ok {
		return
	}
	rid, uid := r.PathValue("id"), r.PathValue("uid")
	var in struct {
		Role string `json:"role"`
	}
	if !readJSON(w, r, 1024, &in) {
		return
	}
	if in.Role != "editor" && in.Role != "commenter" && in.Role != "viewer" {
		writeErr(w, http.StatusBadRequest, "role must be editor, commenter or viewer")
		return
	}
	if !validUUID(uid) || uid == currentUser(r).ID {
		writeErr(w, http.StatusBadRequest, "choose someone else")
		return
	}
	var active bool
	if err := s.db.QueryRow(r.Context(), "SELECT active FROM users WHERE id=$1", uid).Scan(&active); err != nil || !active {
		writeErr(w, http.StatusBadRequest, "that person is not an active user of RoadMap Studio")
		return
	}
	if _, err := s.db.Exec(r.Context(), `INSERT INTO roadmap_members (roadmap_id, user_id, role, added_by) VALUES ($1, $2, $3, $4)
		ON CONFLICT (roadmap_id, user_id) DO UPDATE SET role = EXCLUDED.role`, rid, uid, in.Role, currentUser(r).ID); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.hub.notifyAccess(r.Context(), rid, uid, in.Role)
	s.logEvent(r.Context(), rid, currentUser(r).ID, "share", map[string]any{"user": s.personByID(r.Context(), uid), "role": in.Role})
	s.handleMembers(w, r)
}

func (s *server) handleRemoveMember(w http.ResponseWriter, r *http.Request) {
	rid, uid := r.PathValue("id"), r.PathValue("uid")
	need := "owner"
	if uid == currentUser(r).ID {
		need = "viewer" // anyone may leave a roadmap shared with them
	}
	role, ok := s.access(w, r, need)
	if !ok {
		return
	}
	if role == "owner" && uid == currentUser(r).ID {
		writeErr(w, http.StatusBadRequest, "The owner cannot leave; give the roadmap to someone else first, or delete it.")
		return
	}
	if _, err := s.db.Exec(r.Context(), "DELETE FROM roadmap_members WHERE roadmap_id=$1 AND user_id=$2", rid, uid); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.hub.notifyAccess(r.Context(), rid, uid, "")
	s.logEvent(r.Context(), rid, currentUser(r).ID, map[bool]string{true: "leave", false: "unshare"}[uid == currentUser(r).ID], map[string]any{"user": s.personByID(r.Context(), uid)})
	writeJSON(w, map[string]bool{"ok": true})
}

// handleTransfer makes someone else the owner; the old owner stays as an editor.
func (s *server) handleTransfer(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.access(w, r, "owner"); !ok {
		return
	}
	rid, me := r.PathValue("id"), currentUser(r).ID
	var in struct {
		UserID string `json:"userId"`
	}
	if !readJSON(w, r, 1024, &in) {
		return
	}
	if !validUUID(in.UserID) || in.UserID == me {
		writeErr(w, http.StatusBadRequest, "choose someone else")
		return
	}
	if err := s.transferOwnership(r.Context(), rid, me, in.UserID); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.hub.notifyAccess(r.Context(), rid, in.UserID, "owner")
	s.hub.notifyAccess(r.Context(), rid, me, "editor")
	s.logEvent(r.Context(), rid, me, "transfer", map[string]any{"user": s.personByID(r.Context(), in.UserID)})
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *server) transferOwnership(ctx context.Context, rid, from, to string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var active bool
	if err := tx.QueryRow(ctx, "SELECT active FROM users WHERE id=$1", to).Scan(&active); err != nil || !active {
		return errors.New("that person is not an active user of RoadMap Studio")
	}
	if _, err := tx.Exec(ctx, "UPDATE roadmaps SET owner_id=$2 WHERE id=$1", rid, to); err != nil {
		return err
	}
	tx.Exec(ctx, "DELETE FROM roadmap_members WHERE roadmap_id=$1 AND user_id=$2", rid, to)
	if from != "" {
		if _, err := tx.Exec(ctx, `INSERT INTO roadmap_members (roadmap_id, user_id, role, added_by) VALUES ($1, $2, 'editor', $3)
			ON CONFLICT (roadmap_id, user_id) DO UPDATE SET role='editor'`, rid, from, to); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// ---- versions --------------------------------------------------------------------

func (s *server) handleListVersions(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.access(w, r, "viewer"); !ok {
		return
	}
	rows, err := s.db.Query(r.Context(), `SELECT v.id, v.rev, v.label, v.auto, v.items, v.created_at, coalesce(u.name, '')
		FROM roadmap_versions v LEFT JOIN users u ON u.id = v.created_by
		WHERE v.roadmap_id=$1 ORDER BY v.created_at DESC LIMIT 500`, r.PathValue("id"))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer rows.Close()
	type ver struct {
		ID    int64     `json:"id"`
		Rev   int64     `json:"rev"`
		Label string    `json:"label"`
		Auto  bool      `json:"auto"`
		Items int       `json:"items"`
		At    time.Time `json:"at"`
		By    string    `json:"by"`
	}
	out := []ver{}
	for rows.Next() {
		var v ver
		if err := rows.Scan(&v.ID, &v.Rev, &v.Label, &v.Auto, &v.Items, &v.At, &v.By); err == nil {
			out = append(out, v)
		}
	}
	writeJSON(w, out)
}

func (s *server) handleSaveVersion(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.access(w, r, "editor"); !ok {
		return
	}
	var in struct {
		Label string `json:"label"`
	}
	if !readJSON(w, r, 4096, &in) {
		return
	}
	label := strings.TrimSpace(in.Label)
	if label == "" {
		label = "Saved version"
	}
	if len(label) > 200 {
		label = label[:200]
	}
	var doc []byte
	var rev int64
	if err := s.db.QueryRow(r.Context(), "SELECT doc, rev FROM roadmaps WHERE id=$1", r.PathValue("id")).Scan(&doc, &rev); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	_, items := docSummary(doc)
	if _, err := s.db.Exec(r.Context(), `INSERT INTO roadmap_versions (roadmap_id, rev, label, auto, items, doc, created_by)
		VALUES ($1, $2, $3, false, $4, $5, $6)`, r.PathValue("id"), rev, label, items, doc, currentUser(r).ID); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.logEvent(r.Context(), r.PathValue("id"), currentUser(r).ID, "version", map[string]any{"label": label})
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *server) handleGetVersion(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.access(w, r, "viewer"); !ok {
		return
	}
	vid, _ := strconv.ParseInt(r.PathValue("vid"), 10, 64)
	var doc []byte
	var at time.Time
	err := s.db.QueryRow(r.Context(), "SELECT doc, created_at FROM roadmap_versions WHERE id=$1 AND roadmap_id=$2", vid, r.PathValue("id")).Scan(&doc, &at)
	if err != nil {
		writeErr(w, http.StatusNotFound, "no such version")
		return
	}
	writeJSON(w, map[string]any{"doc": json.RawMessage(doc), "at": at})
}

func (s *server) handleDeleteVersion(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.access(w, r, "editor"); !ok {
		return
	}
	vid, _ := strconv.ParseInt(r.PathValue("vid"), 10, 64)
	s.db.Exec(r.Context(), "DELETE FROM roadmap_versions WHERE id=$1 AND roadmap_id=$2", vid, r.PathValue("id"))
	writeJSON(w, map[string]bool{"ok": true})
}
