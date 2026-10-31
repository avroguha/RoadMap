package main

// Live updates. Each open roadmap in a browser holds one Server-Sent Events
// stream (plain HTTP, so it passes proxies that break WebSockets). Edits
// reach it like this:
//
//   POST .../ops  ->  applied in a transaction  ->  NOTIFY rms_ops 'id:rev'
//   every instance LISTENs  ->  reads the new batches from roadmap_ops  ->
//   writes them, in rev order, to each of its streams on that roadmap
//
// Going through Postgres even with one instance means two or more app
// containers behind a load balancer need nothing extra. A browser that
// reconnects sends Last-Event-ID (its rev) and is caught up from the log; one
// that has been away longer than the log reaches is told to reload.
//
// Presence (who has the roadmap open, and what they have selected) travels
// the same way: each instance publishes the people it serves, every instance
// merges the lists.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	catchUpLimit     = 2000
	presenceEvery    = 20 * time.Second
	presenceLifetime = 60 * time.Second
)

type presence struct {
	Conn     string       `json:"conn"`
	UserID   string       `json:"userId"`
	Name     string       `json:"name"`
	Initials string       `json:"initials"`
	Color    string       `json:"color"`
	Sel      string       `json:"sel,omitempty"`
	Cur      *cursorPos   `json:"cur,omitempty"`   // where their pointer is, in timeline terms
	Doing    string       `json:"doing,omitempty"` // "editing API gateway v2", "viewing", ...
	Pres     *presentView `json:"pres,omitempty"`  // set while this person is presenting
}

// presentView is what a presenter's screen shows, so that people following
// the presentation see the same thing: which roadmap of the deck, the zoom
// and scroll position, and the item in the spotlight. Next is set just
// before the presenter moves to another roadmap, so followers move too.
type presentView struct {
	Title string  `json:"title"`
	I     int     `json:"i"`
	N     int     `json:"n"`
	Zoom  any     `json:"zoom"` // a number, or "fit"
	SX    float64 `json:"sx"`
	SY    float64 `json:"sy"`
	Sel   string  `json:"sel,omitempty"`
	Next  string  `json:"next,omitempty"`
}

func (p *presentView) valid() bool {
	if len([]rune(p.Title)) > 120 || len(p.Sel) > maxIDLen || len(p.Next) > maxIDLen || p.I < 0 || p.N < 0 || p.N > 500 {
		return false
	}
	if p.SX != p.SX || p.SY != p.SY { // NaN
		return false
	}
	switch z := p.Zoom.(type) {
	case nil, float64:
	case string:
		if z != "fit" {
			return false
		}
	default:
		return false
	}
	return true
}

func (a *presentView) equal(b *presentView) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// cursorPos is zoom-independent: a (fractional) day, and a row with a
// fraction of its height - so every browser draws it in the right place.
type cursorPos struct {
	D   float64 `json:"d"`
	Sub string  `json:"sub"`
	F   float64 `json:"f"`
}

func (a *cursorPos) equal(b *cursorPos) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.D == b.D && a.Sub == b.Sub && a.F == b.F
}

type sseClient struct {
	conn    string
	user    *user
	rid     string
	lastRev int64
	sel     string
	cur     *cursorPos
	doing   string
	pres    *presentView
	out     chan []byte
	gone    chan struct{}
	once    sync.Once
}

func (c *sseClient) close() { c.once.Do(func() { close(c.gone) }) }

// send never blocks: a browser that cannot keep up is disconnected and
// catches up when its EventSource reconnects.
func (c *sseClient) send(frame []byte) {
	select {
	case c.out <- frame:
	default:
		c.close()
	}
}

type room struct {
	mu      sync.Mutex // serialises catch-up, so every stream sees revs in order
	clients map[*sseClient]bool
}

type hub struct {
	publishTimers map[string]*time.Timer // per roadmap, see publishSoon
	s             *server
	instance      string

	mu     sync.Mutex
	rooms  map[string]*room
	remote map[string]map[string]remoteList // roadmap -> instance -> its people
}

type remoteList struct {
	at     time.Time
	people []presence
}

func newHub(s *server) *hub {
	return &hub{s: s, instance: fmt.Sprintf("%x", randomBytes(6)), rooms: map[string]*room{}, remote: map[string]map[string]remoteList{}}
}

func sseFrame(event string, id int64, v any) []byte {
	data, _ := json.Marshal(v)
	if id > 0 {
		return []byte(fmt.Sprintf("id: %d\nevent: %s\ndata: %s\n\n", id, event, data))
	}
	return []byte(fmt.Sprintf("event: %s\ndata: %s\n\n", event, data))
}

func (h *hub) room(rid string, create bool) *room {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[rid]
	if r == nil && create {
		r = &room{clients: map[*sseClient]bool{}}
		h.rooms[rid] = r
	}
	return r
}

// catchUp sends every stream in the room the batches it has not seen.
func (h *hub) catchUp(ctx context.Context, rid string) {
	r := h.room(rid, false)
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.clients) == 0 {
		return
	}
	// Usually everyone in a room is at the same rev, so this is one query.
	// Grouped by position, so one browser far behind never holds up - or
	// forces a reload on - the others.
	byRev := map[int64][]*sseClient{}
	for c := range r.clients {
		byRev[c.lastRev] = append(byRev[c.lastRev], c)
	}
	for from, group := range byRev {
		batches, err := h.s.batchesAfter(ctx, rid, from)
		if err != nil {
			if ctx.Err() == nil {
				log.Printf("live updates for %s: %v", rid, err)
			}
			return
		}
		if len(batches) == 0 {
			continue
		}
		// A gap: the log no longer reaches back to this rev (or it is too far).
		if batches[0].Rev != from+1 || len(batches) > catchUpLimit {
			for _, c := range group {
				c.send(sseFrame("reload", 0, map[string]string{"reason": "too far behind"}))
				c.close()
			}
			continue
		}
		for _, c := range group {
			for _, b := range batches {
				c.send(sseFrame("ops", b.Rev, b))
			}
			c.lastRev = batches[len(batches)-1].Rev
		}
	}
}

type opsBatch struct {
	Rev     int64           `json:"rev"`
	BatchID string          `json:"batchId"`
	UserID  string          `json:"userId"`
	Name    string          `json:"name"`
	Ops     json.RawMessage `json:"ops"`
}

func (s *server) batchesAfter(ctx context.Context, rid string, from int64) ([]opsBatch, error) {
	rows, err := s.db.Query(ctx, `SELECT o.rev, o.batch_id, coalesce(o.user_id::text, ''), o.ops, coalesce(u.name, '')
		FROM roadmap_ops o LEFT JOIN users u ON u.id = o.user_id
		WHERE o.roadmap_id=$1 AND o.rev>$2 ORDER BY o.rev LIMIT $3`, rid, from, catchUpLimit+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []opsBatch
	for rows.Next() {
		var b opsBatch
		if err := rows.Scan(&b.Rev, &b.BatchID, &b.UserID, &b.Ops, &b.Name); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// ---- presence ---------------------------------------------------------------

func (h *hub) localPeople(rid string) []presence {
	r := h.room(rid, false)
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []presence
	for c := range r.clients {
		out = append(out, presence{Conn: c.conn, UserID: c.user.ID, Name: c.user.Name, Initials: c.user.Initials, Color: c.user.Color, Sel: c.sel, Cur: c.cur, Doing: c.doing, Pres: c.pres})
	}
	if len(out) > 100 {
		out = out[:100]
	}
	return out
}

func (h *hub) publishPresence(ctx context.Context, rid string) {
	payload, _ := json.Marshal(map[string]any{"i": h.instance, "r": rid, "p": h.localPeople(rid)})
	if _, err := h.s.db.Exec(ctx, "SELECT pg_notify('rms_presence', $1)", string(payload)); err != nil && ctx.Err() == nil {
		log.Printf("presence: %v", err)
	}
}

// publishSoon sends this instance's people to the others at most every
// 300 ms per roadmap: pointer moves arrive many times a second, and Postgres
// NOTIFY is not the place for each one. Local viewers are updated at once.
func (h *hub) publishSoon(rid string) {
	h.broadcastPresence(rid)
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.publishTimers == nil {
		h.publishTimers = map[string]*time.Timer{}
	}
	if h.publishTimers[rid] != nil {
		return
	}
	h.publishTimers[rid] = time.AfterFunc(300*time.Millisecond, func() {
		h.mu.Lock()
		delete(h.publishTimers, rid)
		h.mu.Unlock()
		h.publishPresence(context.Background(), rid)
	})
}

func (h *hub) onPresence(payload string) {
	var m struct {
		I string     `json:"i"`
		R string     `json:"r"`
		P []presence `json:"p"`
	}
	if json.Unmarshal([]byte(payload), &m) != nil {
		return
	}
	h.mu.Lock()
	if h.remote[m.R] == nil {
		h.remote[m.R] = map[string]remoteList{}
	}
	h.remote[m.R][m.I] = remoteList{at: time.Now(), people: m.P}
	h.mu.Unlock()
	h.broadcastPresence(m.R)
}

func (h *hub) broadcastPresence(rid string) {
	all := h.localPeople(rid)
	h.mu.Lock()
	for inst, l := range h.remote[rid] {
		if inst == h.instance {
			continue
		}
		if time.Since(l.at) > presenceLifetime {
			delete(h.remote[rid], inst)
			continue
		}
		all = append(all, l.people...)
	}
	h.mu.Unlock()
	sort.Slice(all, func(i, j int) bool { return all[i].Name < all[j].Name })
	if all == nil {
		all = []presence{}
	}
	if r := h.room(rid, false); r != nil {
		frame := sseFrame("presence", 0, all)
		r.mu.Lock()
		for c := range r.clients {
			c.send(frame)
		}
		r.mu.Unlock()
	}
}

// broadcast sends one frame to everyone who has the roadmap open here.
func (h *hub) broadcast(rid, event string, v any) {
	r := h.room(rid, false)
	if r == nil {
		return
	}
	frame := sseFrame(event, 0, v)
	r.mu.Lock()
	defer r.mu.Unlock()
	for c := range r.clients {
		c.send(frame)
	}
}

// ---- access changes (shared, unshared, deleted) ----------------------------

func (h *hub) notifyAccess(ctx context.Context, rid, userID, role string) {
	payload, _ := json.Marshal(map[string]string{"r": rid, "u": userID, "role": role})
	h.s.db.Exec(ctx, "SELECT pg_notify('rms_access', $1)", string(payload))
}

func (h *hub) onAccess(payload string) {
	var m struct{ R, U, Role string }
	if json.Unmarshal([]byte(payload), &m) != nil {
		return
	}
	r := h.room(m.R, false)
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for c := range r.clients {
		if m.U == "*" || c.user.ID == m.U {
			c.send(sseFrame("access", 0, map[string]string{"role": m.Role}))
			if m.Role == "" {
				c.close()
			}
		}
	}
}

// listen holds one connection that LISTENs, reconnecting when it drops; after
// a reconnect every room is caught up, since notifications may have been lost.
func (h *hub) listen(ctx context.Context) {
	for ctx.Err() == nil {
		conn, err := h.s.db.Acquire(ctx)
		if err != nil {
			time.Sleep(2 * time.Second)
			continue
		}
		pc := conn.Hijack()
		for _, ch := range []string{"rms_ops", "rms_presence", "rms_access", "rms_settings", "rms_comments"} {
			pc.Exec(ctx, "LISTEN "+ch)
		}
		h.mu.Lock()
		rids := make([]string, 0, len(h.rooms))
		for rid := range h.rooms {
			rids = append(rids, rid)
		}
		h.mu.Unlock()
		for _, rid := range rids {
			h.catchUp(ctx, rid)
		}
		for {
			n, err := pc.WaitForNotification(ctx)
			if err != nil {
				if ctx.Err() == nil {
					log.Printf("live updates: listener lost (%v); reconnecting", err)
				}
				break
			}
			switch n.Channel {
			case "rms_ops":
				rid := n.Payload
				for i := len(rid) - 1; i >= 0; i-- {
					if rid[i] == ':' {
						rid = rid[:i]
						break
					}
				}
				h.catchUp(ctx, rid)
			case "rms_presence":
				h.onPresence(n.Payload)
			case "rms_access":
				h.onAccess(n.Payload)
			case "rms_settings":
				go h.s.reloadSSO(ctx)
			case "rms_comments":
				h.broadcast(n.Payload, "comments", nil)
			}
		}
		pc.Close(context.Background())
		time.Sleep(time.Second)
	}
}

// heartbeat republishes presence so other instances keep it, and expires
// the lists of instances that went away.
func (h *hub) heartbeat(ctx context.Context) {
	t := time.NewTicker(presenceEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			h.mu.Lock()
			rids := make([]string, 0, len(h.rooms))
			for rid := range h.rooms {
				rids = append(rids, rid)
			}
			h.mu.Unlock()
			for _, rid := range rids {
				h.publishPresence(ctx, rid)
			}
		}
	}
}

// ---- the stream itself --------------------------------------------------------

func (s *server) handleEvents(w http.ResponseWriter, r *http.Request) {
	u := currentUser(r)
	rid := r.PathValue("id")
	role, err := s.roleFor(r.Context(), rid, u.ID)
	if err != nil || role == "" {
		writeErr(w, http.StatusNotFound, "roadmap not found")
		return
	}
	since, _ := strconv.ParseInt(r.Header.Get("Last-Event-ID"), 10, 64)
	if q := r.URL.Query().Get("rev"); q != "" && since == 0 {
		since, _ = strconv.ParseInt(q, 10, 64)
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, http.StatusInternalServerError, "streaming not supported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no") // nginx and friends: do not hold events back
	w.WriteHeader(http.StatusOK)

	c := &sseClient{conn: fmt.Sprintf("%x", randomBytes(6)), user: u, rid: rid, lastRev: since,
		out: make(chan []byte, 512), gone: make(chan struct{})}
	c.send(sseFrame("hello", 0, map[string]any{"conn": c.conn, "role": role}))
	rm := s.hub.room(rid, true)
	rm.mu.Lock()
	rm.clients[c] = true
	rm.mu.Unlock()
	defer func() {
		rm.mu.Lock()
		delete(rm.clients, c)
		empty := len(rm.clients) == 0
		rm.mu.Unlock()
		if empty {
			s.hub.mu.Lock()
			if r := s.hub.rooms[rid]; r != nil && len(r.clients) == 0 {
				delete(s.hub.rooms, rid)
			}
			s.hub.mu.Unlock()
		}
		s.hub.publishPresence(context.Background(), rid)
	}()
	s.hub.catchUp(r.Context(), rid)
	s.hub.publishPresence(r.Context(), rid)

	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.stopping:
			return
		case <-c.gone:
			// Drain what is queued (a final "access" or "reload") before leaving.
			for {
				select {
				case f := <-c.out:
					w.Write(f)
				default:
					flusher.Flush()
					return
				}
			}
		case f := <-c.out:
			if _, err := w.Write(f); err != nil {
				return
			}
			flusher.Flush()
		case <-ping.C:
			if _, err := w.Write([]byte(": ping\n\n")); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// handlePresence records what this browser has selected.
func (s *server) handlePresence(w http.ResponseWriter, r *http.Request) {
	rid := r.PathValue("id")
	var in struct {
		Conn  string       `json:"conn"`
		Sel   string       `json:"sel"`
		Cur   *cursorPos   `json:"cur"`
		Doing string       `json:"doing"`
		Pres  *presentView `json:"pres"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&in); err != nil {
		writeErr(w, http.StatusBadRequest, "bad presence")
		return
	}
	if len(in.Sel) > maxIDLen {
		in.Sel = ""
	}
	if in.Cur != nil && (len(in.Cur.Sub) > maxIDLen || in.Cur.D != in.Cur.D || in.Cur.F != in.Cur.F) {
		in.Cur = nil
	}
	if n := []rune(in.Doing); len(n) > 80 {
		in.Doing = string(n[:80])
	}
	if in.Pres != nil && !in.Pres.valid() {
		in.Pres = nil
	}
	changed, moved := false, false
	if rm := s.hub.room(rid, false); rm != nil {
		rm.mu.Lock()
		for c := range rm.clients {
			if c.conn != in.Conn || c.user.ID != currentUser(r).ID {
				continue
			}
			if c.sel != in.Sel || c.doing != in.Doing {
				c.sel, c.doing, changed = in.Sel, in.Doing, true
			}
			if !c.cur.equal(in.Cur) {
				c.cur, moved = in.Cur, true
			}
			if !c.pres.equal(in.Pres) {
				// Starting, stopping, moving to the next roadmap: at once.
				// Scrolling and zooming: coalesced like pointer moves.
				if (c.pres == nil) != (in.Pres == nil) || (in.Pres != nil && in.Pres.Next != "") {
					changed = true
				} else {
					moved = true
				}
				c.pres = in.Pres
			}
		}
		rm.mu.Unlock()
	}
	if changed {
		s.hub.publishPresence(r.Context(), rid)
	} else if moved {
		s.hub.publishSoon(rid)
	}
	writeJSON(w, map[string]bool{"ok": true})
}

var _ = pgx.ErrNoRows
