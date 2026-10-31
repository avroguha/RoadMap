package main

// Shared roadmaps: one roadmap per file on a network share, edited by one
// person at a time.
//
//   <name>.roadmap.json   {"kind":"shared-roadmap","rev":N,"savedBy":..,"savedAt":..,"roadmap":{..}}
//   <name>.roadmap.lock   {"user","machine","pid","since","heartbeat"}
//
// The lock is taken by creating the file exclusively (atomic on SMB); the
// holder refreshes "heartbeat" every 30 s. A lock whose heartbeat is older
// than staleAfter belongs to a copy that died and may be taken over. Every
// save checks the file's rev against the rev that was loaded, so even a
// taken-over lock can never overwrite someone else's work unnoticed.

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	lockExt       = ".lock"
	heartbeatEach = 30 * time.Second
	staleAfter    = 2 * time.Minute
)

type sharedFile struct {
	App     string          `json:"app"`
	Kind    string          `json:"kind"`
	Rev     int64           `json:"rev"`
	SavedBy string          `json:"savedBy"`
	SavedAt string          `json:"savedAt"`
	Roadmap json.RawMessage `json:"roadmap"`
}

type lockInfo struct {
	User      string `json:"user"`
	Machine   string `json:"machine"`
	PID       int    `json:"pid"`
	Since     string `json:"since"`
	Heartbeat string `json:"heartbeat"`
}

type lockStatus struct {
	Held  bool      `json:"held"`  // this process holds it
	Free  bool      `json:"free"`  // nobody holds it
	Stale bool      `json:"stale"` // someone held it and stopped heartbeating
	Owner *lockInfo `json:"owner,omitempty"`
}

var (
	heldLocks   = map[string]*time.Ticker{} // path -> heartbeat ticker
	heldLocksMu sync.Mutex
)

func whoAmI() lockInfo {
	name := os.Getenv("USERNAME")
	if name == "" {
		name = os.Getenv("USER")
	}
	if u, err := user.Current(); err == nil && u.Username != "" {
		if i := strings.LastIndexAny(u.Username, `\/`); i >= 0 {
			name = u.Username[i+1:]
		} else {
			name = u.Username
		}
	}
	host, _ := os.Hostname()
	now := time.Now().UTC().Format(time.RFC3339)
	return lockInfo{User: name, Machine: host, PID: os.Getpid(), Since: now, Heartbeat: now}
}

func lockPath(path string) string { return strings.TrimSuffix(path, ".json") + lockExt }

func validSharedPath(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" || !filepath.IsAbs(path) {
		return "", errors.New("the shared file needs a full path (a mapped drive or \\\\server\\share)")
	}
	if !strings.HasSuffix(strings.ToLower(path), ".json") {
		path += ".roadmap.json"
	}
	return filepath.Clean(path), nil
}

func readLock(path string) (*lockInfo, error) {
	data, err := os.ReadFile(lockPath(path))
	if err != nil {
		return nil, err
	}
	var li lockInfo
	if json.Unmarshal(data, &li) != nil {
		return &lockInfo{User: "?", Heartbeat: ""}, nil
	}
	return &li, nil
}

func isStale(li *lockInfo) bool {
	t, err := time.Parse(time.RFC3339, li.Heartbeat)
	return err != nil || time.Since(t) > staleAfter
}

func isMine(li *lockInfo) bool {
	me := whoAmI()
	return li.Machine == me.Machine && li.PID == me.PID
}

func (s *server) lockStatus(path string) lockStatus {
	heldLocksMu.Lock()
	_, held := heldLocks[path]
	heldLocksMu.Unlock()
	li, err := readLock(path)
	if err != nil {
		if held { // our lock file vanished (someone deleted it): we no longer hold it
			s.dropLock(path)
		}
		return lockStatus{Free: true}
	}
	if held && isMine(li) {
		return lockStatus{Held: true, Owner: li}
	}
	if held { // taken over while we were away
		s.dropLock(path)
	}
	return lockStatus{Owner: li, Stale: isStale(li)}
}

// acquireLock takes the lock; takeover allows replacing a stale one.
func (s *server) acquireLock(path string, takeover bool) (lockStatus, error) {
	st := s.lockStatus(path)
	if st.Held {
		return st, nil
	}
	if !st.Free && !(takeover && st.Stale) {
		return st, nil
	}
	if st.Stale && takeover {
		os.Remove(lockPath(path))
	}
	me := whoAmI()
	data, _ := json.MarshalIndent(me, "", "  ")
	f, err := os.OpenFile(lockPath(path), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		if os.IsExist(err) { // lost the race to somebody else
			return s.lockStatus(path), nil
		}
		return st, err
	}
	f.Write(data)
	f.Close()
	heldLocksMu.Lock()
	t := time.NewTicker(heartbeatEach)
	heldLocks[path] = t
	heldLocksMu.Unlock()
	go func() {
		for range t.C {
			li, err := readLock(path)
			if err != nil || !isMine(li) {
				s.dropLock(path) // somebody took it over: stop pretending
				return
			}
			li.Heartbeat = time.Now().UTC().Format(time.RFC3339)
			data, _ := json.MarshalIndent(li, "", "  ")
			atomicWrite(lockPath(path), data)
		}
	}()
	return lockStatus{Held: true, Owner: &me}, nil
}

func (s *server) dropLock(path string) {
	heldLocksMu.Lock()
	if t, ok := heldLocks[path]; ok {
		t.Stop()
		delete(heldLocks, path)
	}
	heldLocksMu.Unlock()
}

// releaseLock gives the lock back (only if it is ours).
func (s *server) releaseLock(path string) {
	if li, err := readLock(path); err == nil && isMine(li) {
		os.Remove(lockPath(path))
	}
	s.dropLock(path)
}

// releaseAllLocks runs on every exit path the process controls.
func (s *server) releaseAllLocks() {
	heldLocksMu.Lock()
	paths := make([]string, 0, len(heldLocks))
	for p := range heldLocks {
		paths = append(paths, p)
	}
	heldLocksMu.Unlock()
	for _, p := range paths {
		s.releaseLock(p)
	}
}

func readShared(path string) (*sharedFile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var sf sharedFile
	if err := json.Unmarshal(data, &sf); err != nil || len(sf.Roadmap) == 0 {
		return nil, errors.New("this is not a shared roadmap file")
	}
	return &sf, nil
}

func writeShared(path string, sf *sharedFile) error {
	sf.App, sf.Kind = appName, "shared-roadmap"
	sf.SavedBy = whoAmI().User
	sf.SavedAt = time.Now().UTC().Format(time.RFC3339)
	data, err := json.Marshal(sf)
	if err != nil {
		return err
	}
	return atomicWrite(path, data)
}

// ---- API ----------------------------------------------------------------

func (s *server) sharedAPI(w http.ResponseWriter, r *http.Request, action string) error {
	if r.Method != http.MethodPost {
		http.NotFound(w, r)
		return nil
	}
	var in struct {
		Path     string          `json:"path"`
		Rev      int64           `json:"rev"`
		Takeover bool            `json:"takeover"`
		Edit     bool            `json:"edit"`
		Roadmap  json.RawMessage `json:"roadmap"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		return err
	}
	path, err := validSharedPath(in.Path)
	if err != nil && action != "browse" {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	switch action {
	case "create":
		if _, err := os.Stat(path); err == nil {
			return errors.New("a file with that name already exists on the share")
		}
		if len(in.Roadmap) == 0 {
			return errors.New("nothing to share")
		}
		if err := writeShared(path, &sharedFile{Rev: 1, Roadmap: in.Roadmap}); err != nil {
			return err
		}
		lock, _ := s.acquireLock(path, false)
		sf, _ := readShared(path)
		writeJSON(w, map[string]any{"ok": true, "path": path, "rev": sf.Rev, "savedBy": sf.SavedBy, "savedAt": sf.SavedAt, "roadmap": sf.Roadmap, "lock": lock, "me": whoAmI().User})
	case "open":
		sf, err := readShared(path)
		if err != nil {
			return err
		}
		var lock lockStatus
		if in.Edit {
			lock, _ = s.acquireLock(path, in.Takeover)
		} else {
			lock = s.lockStatus(path)
		}
		writeJSON(w, map[string]any{"ok": true, "path": path, "rev": sf.Rev, "savedBy": sf.SavedBy, "savedAt": sf.SavedAt, "roadmap": sf.Roadmap, "lock": lock, "me": whoAmI().User})
	case "status":
		sf, err := readShared(path)
		if err != nil {
			return err
		}
		writeJSON(w, map[string]any{"ok": true, "rev": sf.Rev, "savedBy": sf.SavedBy, "savedAt": sf.SavedAt, "lock": s.lockStatus(path)})
	case "save":
		lock := s.lockStatus(path)
		if !lock.Held {
			writeJSON(w, map[string]any{"ok": false, "reason": "lock", "lock": lock})
			return nil
		}
		cur, err := readShared(path)
		if err != nil {
			return err
		}
		if cur.Rev != in.Rev {
			writeJSON(w, map[string]any{"ok": false, "reason": "conflict", "rev": cur.Rev, "savedBy": cur.SavedBy, "savedAt": cur.SavedAt, "lock": lock})
			return nil
		}
		sf := &sharedFile{Rev: cur.Rev + 1, Roadmap: in.Roadmap}
		if err := writeShared(path, sf); err != nil {
			return err
		}
		writeJSON(w, map[string]any{"ok": true, "rev": sf.Rev, "savedBy": sf.SavedBy, "savedAt": sf.SavedAt})
	case "lock":
		lock, err := s.acquireLock(path, in.Takeover)
		if err != nil {
			return err
		}
		sf, _ := readShared(path)
		out := map[string]any{"ok": true, "lock": lock}
		if sf != nil {
			out["rev"], out["roadmap"], out["savedBy"], out["savedAt"] = sf.Rev, sf.Roadmap, sf.SavedBy, sf.SavedAt
		}
		writeJSON(w, out)
	case "release", "close":
		s.releaseLock(path)
		writeJSON(w, map[string]any{"ok": true})
	case "browse":
		// Native file pickers, when we have a window.
		var p string
		var ok bool
		if in.Edit {
			p, ok = saveDialog(s.owner(), "Save as shared roadmap", "roadmap.roadmap.json", "Shared roadmap|*.roadmap.json")
		} else {
			p, ok = openDialog(s.owner(), "Open shared roadmap", "Shared roadmap|*.roadmap.json|All files|*.*")
		}
		writeJSON(w, map[string]any{"ok": ok, "path": p, "native": s.native})
	default:
		http.NotFound(w, r)
	}
	return nil
}
