package main

// Comments on timeline items. Anyone with at least the "commenter" role may
// add one; the author or the roadmap's owner may remove it; anyone who can
// comment may mark one resolved. Every change is announced to the roadmap's
// live viewers through NOTIFY rms_comments.

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type comment struct {
	ID       int64      `json:"id"`
	ItemID   string     `json:"itemId"`
	User     personRef  `json:"user"`
	Body     string     `json:"body"`
	At       time.Time  `json:"at"`
	Resolved *time.Time `json:"resolved,omitempty"`
	Mine     bool       `json:"mine"`
}

func (s *server) handleListComments(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.access(w, r, "viewer"); !ok {
		return
	}
	rows, err := s.db.Query(r.Context(), `SELECT c.id, c.item_id, coalesce(u.id::text, ''), coalesce(u.name, 'Former user'), coalesce(u.email, ''), c.body, c.created_at, c.resolved_at
		FROM roadmap_comments c LEFT JOIN users u ON u.id = c.user_id
		WHERE c.roadmap_id = $1 AND c.deleted_at IS NULL ORDER BY c.created_at`, r.PathValue("id"))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer rows.Close()
	me := currentUser(r).ID
	out := []comment{}
	for rows.Next() {
		var c comment
		var uid, name, email string
		if err := rows.Scan(&c.ID, &c.ItemID, &uid, &name, &email, &c.Body, &c.At, &c.Resolved); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		c.User = ref(uid, name, email, "")
		c.Mine = uid == me
		out = append(out, c)
	}
	writeJSON(w, out)
}

func (s *server) handleAddComment(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.access(w, r, "commenter"); !ok {
		return
	}
	var in struct {
		ItemID string `json:"itemId"`
		Body   string `json:"body"`
	}
	if !readJSON(w, r, 64<<10, &in) {
		return
	}
	in.Body = strings.TrimSpace(in.Body)
	if in.Body == "" || len(in.Body) > 10000 || in.ItemID == "" || len(in.ItemID) > 64 {
		writeErr(w, http.StatusBadRequest, "a comment needs some text (up to 10,000 characters) and an item")
		return
	}
	rid := r.PathValue("id")
	if _, err := s.db.Exec(r.Context(), "INSERT INTO roadmap_comments (roadmap_id, item_id, user_id, body) VALUES ($1, $2, $3, $4)",
		rid, in.ItemID, currentUser(r).ID, in.Body); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.db.Exec(r.Context(), "SELECT pg_notify('rms_comments', $1)", rid)
	s.handleListComments(w, r)
}

func (s *server) handleResolveComment(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.access(w, r, "commenter"); !ok {
		return
	}
	cid, err := strconv.ParseInt(r.PathValue("cid"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad comment id")
		return
	}
	var in struct {
		Resolved bool `json:"resolved"`
	}
	if !readJSON(w, r, 1024, &in) {
		return
	}
	rid := r.PathValue("id")
	var q string
	if in.Resolved {
		q = "UPDATE roadmap_comments SET resolved_at = now(), resolved_by = $3 WHERE id = $1 AND roadmap_id = $2 AND deleted_at IS NULL"
	} else {
		q = "UPDATE roadmap_comments SET resolved_at = NULL, resolved_by = $3 WHERE id = $1 AND roadmap_id = $2 AND deleted_at IS NULL"
	}
	if _, err := s.db.Exec(r.Context(), q, cid, rid, currentUser(r).ID); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.db.Exec(r.Context(), "SELECT pg_notify('rms_comments', $1)", rid)
	s.handleListComments(w, r)
}

// handleDeleteComment: the owner of the roadmap removes any comment; an
// author removes their own.
func (s *server) handleDeleteComment(w http.ResponseWriter, r *http.Request) {
	role, ok := s.access(w, r, "commenter")
	if !ok {
		return
	}
	cid, err := strconv.ParseInt(r.PathValue("cid"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad comment id")
		return
	}
	rid, me := r.PathValue("id"), currentUser(r).ID
	var author *string
	if err := s.db.QueryRow(r.Context(), "SELECT user_id::text FROM roadmap_comments WHERE id = $1 AND roadmap_id = $2 AND deleted_at IS NULL", cid, rid).Scan(&author); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "no such comment")
			return
		}
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if role != "owner" && (author == nil || *author != me) {
		writeErr(w, http.StatusForbidden, "Only the roadmap's owner or the comment's author can remove it.")
		return
	}
	s.db.Exec(r.Context(), "UPDATE roadmap_comments SET deleted_at = now(), deleted_by = $3 WHERE id = $1 AND roadmap_id = $2", cid, rid, me)
	if author != nil && *author != me {
		s.logEvent(r.Context(), rid, me, "comment-removed", map[string]any{"user": s.personByID(r.Context(), *author)})
	}
	s.db.Exec(r.Context(), "SELECT pg_notify('rms_comments', $1)", rid)
	s.handleListComments(w, r)
}

// handleSetEveryone: the owner shares the roadmap with everyone in the
// organisation at a role, or stops ("").
func (s *server) handleSetEveryone(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.access(w, r, "owner"); !ok {
		return
	}
	var in struct {
		Role string `json:"role"`
	}
	if !readJSON(w, r, 1024, &in) {
		return
	}
	switch in.Role {
	case "", "viewer", "commenter", "editor":
	default:
		writeErr(w, http.StatusBadRequest, "role must be viewer, commenter, editor or empty")
		return
	}
	rid := r.PathValue("id")
	if _, err := s.db.Exec(r.Context(), "UPDATE roadmaps SET everyone_role = $2 WHERE id = $1", rid, in.Role); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Everyone with it open re-reads their own access: members keep their
	// role, people who were in through "everyone" get the new one or lose it.
	s.hub.notifyAccess(r.Context(), rid, "*", "recheck")
	s.logEvent(r.Context(), rid, currentUser(r).ID, "everyone", map[string]any{"role": in.Role})
	s.handleMembers(w, r)
}
