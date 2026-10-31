package main

// The change history of a roadmap: what every batch of edits changed, who
// made it and when, plus the events around the roadmap (sharing, versions).

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"sort"
	"strconv"
	"time"
)

// activityEntry is one change inside a batch, in terms a person understands.
type activityEntry struct {
	Op     string `json:"op"`              // set | add | del | move | root | many
	Kind   string `json:"kind,omitempty"`  // lane | sub | item | marker | roadmap
	ID     string `json:"id,omitempty"`    // the entity (still valid unless deleted)
	Name   string `json:"name,omitempty"`  // its name at the time
	Field  string `json:"field,omitempty"` // for set / root
	From   any    `json:"from,omitempty"`
	To     any    `json:"to,omitempty"`
	Parent string `json:"parent,omitempty"` // for add / move: where it went
	Count  int    `json:"count,omitempty"`  // for many
}

const maxEntriesPerBatch = 60

func nameOf(n map[string]any) string {
	if n == nil {
		return ""
	}
	s, _ := n["name"].(string)
	return s
}

// describeOps says what a batch will change, read against the document as it
// is BEFORE the batch is applied (so old values and deleted names are known).
func describeOps(doc []byte, ops []op) []activityEntry {
	var root map[string]any
	if json.Unmarshal(doc, &root) != nil || root == nil {
		return nil
	}
	d := indexDoc(root)
	var out []activityEntry
	add := func(e activityEntry) { out = append(out, e) }
	for _, o := range ops {
		switch o.T {
		case "root":
			for k, v := range o.F {
				if rootFields[k] {
					if old := root[k]; !reflect.DeepEqual(old, v) {
						add(activityEntry{Op: "root", Kind: "roadmap", Field: k, From: old, To: v})
					}
				} else {
					add(activityEntry{Op: "root", Kind: "roadmap", Field: "view"})
				}
			}
		case "set":
			e := d.ents[o.ID]
			if e == nil {
				continue
			}
			for k, v := range o.F {
				if protected[k] {
					continue
				}
				if old := e.node[k]; !reflect.DeepEqual(old, v) {
					add(activityEntry{Op: "set", Kind: e.kind, ID: o.ID, Name: nameOf(e.node), Field: k, From: old, To: v})
				}
			}
		case "add":
			name, _ := o.Data["name"].(string)
			parent := ""
			if p := d.ents[o.Parent]; p != nil {
				parent = nameOf(p.node)
			}
			add(activityEntry{Op: "add", Kind: o.Kind, ID: o.ID, Name: name, Parent: parent})
		case "move":
			e := d.ents[o.ID]
			if e == nil {
				continue
			}
			parent := ""
			if p := d.ents[o.Parent]; p != nil {
				parent = nameOf(p.node)
			}
			add(activityEntry{Op: "move", Kind: e.kind, ID: o.ID, Name: nameOf(e.node), Parent: parent})
		case "del":
			e := d.ents[o.ID]
			if e == nil {
				continue
			}
			add(activityEntry{Op: "del", Kind: e.kind, ID: o.ID, Name: nameOf(e.node)})
		}
		if len(out) > maxEntriesPerBatch {
			break
		}
	}
	// A huge paste or import: keep the first entries and say how many more.
	if len(out) > maxEntriesPerBatch {
		rest := len(ops) - maxEntriesPerBatch
		out = append(out[:maxEntriesPerBatch], activityEntry{Op: "many", Count: rest})
	}
	return out
}

// logEvent records something that happened to the roadmap other than an edit.
func (s *server) logEvent(ctx context.Context, rid, uid, kind string, detail map[string]any) {
	raw, _ := json.Marshal(detail)
	if _, err := s.db.Exec(ctx, "INSERT INTO roadmap_events (roadmap_id, user_id, kind, detail) VALUES ($1, $2, $3, $4)", rid, nullIfEmpty(uid), kind, raw); err != nil {
		// History is not worth failing the action for; it is logged and that is all.
		println("activity:", err.Error())
	}
}

func nullIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

type activityRow struct {
	At      time.Time       `json:"at"`
	By      personRef       `json:"by"`
	Rev     int64           `json:"rev,omitempty"` // an edit batch
	Entries json.RawMessage `json:"entries,omitempty"`
	Ops     int             `json:"ops,omitempty"`  // how many operations (for batches before summaries existed)
	Kind    string          `json:"kind,omitempty"` // an event
	Detail  json.RawMessage `json:"detail,omitempty"`
}

// handleActivity returns the newest rows first, before a given time, merging
// edit batches and events. ?before=<unix ms> pages backwards.
func (s *server) handleActivity(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.access(w, r, "viewer"); !ok {
		return
	}
	rid := r.PathValue("id")
	before := time.Now().Add(time.Hour)
	if ms, err := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64); err == nil && ms > 0 {
		before = time.UnixMilli(ms)
	}
	const limit = 120
	rows, err := s.db.Query(r.Context(), `SELECT o.rev, o.created_at, coalesce(u.id::text, ''), coalesce(u.name, 'Former user'), coalesce(u.email, ''), o.summary, jsonb_array_length(o.ops)
		FROM roadmap_ops o LEFT JOIN users u ON u.id = o.user_id
		WHERE o.roadmap_id = $1 AND o.created_at < $2 ORDER BY o.created_at DESC LIMIT $3`, rid, before, limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	var out []activityRow
	for rows.Next() {
		var a activityRow
		var uid, name, email string
		var summary []byte
		if err := rows.Scan(&a.Rev, &a.At, &uid, &name, &email, &summary, &a.Ops); err != nil {
			rows.Close()
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		a.By = ref(uid, name, email, "")
		if len(summary) > 0 {
			a.Entries = summary
		}
		out = append(out, a)
	}
	rows.Close()
	rows, err = s.db.Query(r.Context(), `SELECT e.kind, e.detail, e.created_at, coalesce(u.id::text, ''), coalesce(u.name, 'Former user'), coalesce(u.email, '')
		FROM roadmap_events e LEFT JOIN users u ON u.id = e.user_id
		WHERE e.roadmap_id = $1 AND e.created_at < $2 ORDER BY e.created_at DESC LIMIT $3`, rid, before, limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	for rows.Next() {
		var a activityRow
		var uid, name, email string
		var detail []byte
		if err := rows.Scan(&a.Kind, &detail, &a.At, &uid, &name, &email); err != nil {
			rows.Close()
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		a.By = ref(uid, name, email, "")
		a.Detail = detail
		out = append(out, a)
	}
	rows.Close()
	sort.SliceStable(out, func(i, j int) bool { return out[i].At.After(out[j].At) })
	more := len(out) > limit
	if more {
		out = out[:limit]
	}
	if out == nil {
		out = []activityRow{}
	}
	writeJSON(w, map[string]any{"rows": out, "more": more || len(out) == limit})
}
