package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	maxBody          = 64 << 20
	maxSnapshots     = 300
	autoSnapshotGap  = 2 * time.Minute
	workspaceFile    = "workspace.json"
	workspaceBackup  = "workspace.bak.json"
	historyDirName   = "history"
	snapshotFileExt  = ".json"
	browserPingGrace = 20 * time.Second
)

var idPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

var contentTypes = map[string]string{
	".html": "text/html; charset=utf-8",
	".js":   "text/javascript; charset=utf-8",
	".css":  "text/css; charset=utf-8",
	".svg":  "image/svg+xml",
	".png":  "image/png",
	".ico":  "image/x-icon",
	".json": "application/json",
}

type server struct {
	dataDir string
	token   string
	host    string
	ui      fs.FS
	dev     bool
	native  bool // native dialogs and clipboard available (window mode)
	browser bool // UI is shown in the user's browser; the page can ask us to quit
	owner   func() uintptr

	mu       sync.Mutex
	lastPing time.Time
	pinged   bool
}

func newServer(dataDir, token, host string, ui fs.FS, dev bool) *server {
	return &server{dataDir: dataDir, token: token, host: host, ui: ui, dev: dev, native: !dev,
		owner: func() uintptr { return 0 }}
}

type snapshot struct {
	TS      int64           `json:"ts"`
	Label   string          `json:"label"`
	Auto    bool            `json:"auto"`
	Roadmap json.RawMessage `json:"roadmap"`
}

type snapshotInfo struct {
	TS    int64  `json:"ts"`
	Label string `json:"label"`
	Auto  bool   `json:"auto"`
	Name  string `json:"name"`
	Items int    `json:"items"`
	Size  int    `json:"size"`
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Loopback only, and only under our own host name (blocks DNS rebinding).
	if r.Host != s.host && r.Host != strings.Replace(s.host, "127.0.0.1", "localhost", 1) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if strings.HasPrefix(r.URL.Path, "/api/") {
		if s.token != "" && r.Header.Get("X-Token") != s.token {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxBody)
		s.api(w, r)
		return
	}
	s.static(w, r)
}

func (s *server) static(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if name == "" {
		name = "index.html"
	}
	data, err := fs.ReadFile(s.ui, name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if ct, ok := contentTypes[path.Ext(name)]; ok {
		w.Header().Set("Content-Type", ct)
	}
	w.Write(data)
}

func (s *server) api(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/"), "/"), "/")
	var err error
	switch {
	case parts[0] == "info" && r.Method == http.MethodGet:
		writeJSON(w, map[string]any{"app": appName, "version": appVersion, "dataDir": s.dataDir, "native": s.native, "browser": s.browser})
	case parts[0] == "ping":
		s.mu.Lock()
		s.lastPing, s.pinged = time.Now(), true
		s.mu.Unlock()
		writeJSON(w, map[string]any{"ok": true})
	case parts[0] == "quit" && r.Method == http.MethodPost && s.browser:
		writeJSON(w, map[string]any{"ok": true})
		go func() { time.Sleep(300 * time.Millisecond); s.releaseAllLocks(); forgetInstance(s.dataDir); os.Exit(0) }()
	case parts[0] == "shared" && len(parts) == 2:
		err = s.sharedAPI(w, r, parts[1])
	case parts[0] == "update" && len(parts) == 2:
		err = s.updateAPI(w, r, parts[1])
	case parts[0] == "workspace" && r.Method == http.MethodGet:
		err = s.getWorkspace(w)
	case parts[0] == "workspace" && r.Method == http.MethodPut:
		err = s.putWorkspace(w, r)
	case parts[0] == "history" && len(parts) == 2 && r.Method == http.MethodGet:
		err = s.listHistory(w, parts[1])
	case parts[0] == "history" && len(parts) == 2 && r.Method == http.MethodPost:
		err = s.addHistory(w, r, parts[1])
	case parts[0] == "history" && len(parts) == 3 && r.Method == http.MethodGet:
		err = s.getSnapshot(w, parts[1], parts[2])
	case parts[0] == "history" && len(parts) == 3 && r.Method == http.MethodDelete:
		err = s.deleteSnapshot(w, parts[1], parts[2])
	case parts[0] == "backup" && r.Method == http.MethodGet:
		err = s.backup(w)
	case parts[0] == "restore" && r.Method == http.MethodPost:
		err = s.restore(w, r)
	case parts[0] == "savefile" && r.Method == http.MethodPost:
		err = s.saveFile(w, r)
	case parts[0] == "openfile" && r.Method == http.MethodPost:
		err = s.openFile(w, r)
	case parts[0] == "clipboard-image" && r.Method == http.MethodPost:
		err = s.clipboardImage(w, r)
	case parts[0] == "open-data-dir" && r.Method == http.MethodPost:
		openFolder(s.dataDir)
		writeJSON(w, map[string]any{"ok": true})
	default:
		http.NotFound(w, r)
	}
	if err != nil {
		log.Println("api", r.Method, r.URL.Path, "->", err)
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

// ---- workspace ----------------------------------------------------------

func (s *server) getWorkspace(w http.ResponseWriter) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, name := range []string{workspaceFile, workspaceBackup} {
		data, err := os.ReadFile(filepath.Join(s.dataDir, name))
		if err == nil && json.Valid(data) {
			w.Header().Set("Content-Type", "application/json")
			w.Write(data)
			return nil
		}
		if err == nil {
			log.Println(name, "is not valid JSON - trying the backup")
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte("null"))
	return nil
}

func (s *server) putWorkspace(w http.ResponseWriter, r *http.Request) error {
	data, err := io.ReadAll(r.Body)
	if err != nil {
		return err
	}
	if !json.Valid(data) {
		return errors.New("workspace is not valid JSON")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.writeWorkspaceLocked(data); err != nil {
		return err
	}
	writeJSON(w, map[string]any{"ok": true})
	return nil
}

func (s *server) writeWorkspaceLocked(data []byte) error {
	target := filepath.Join(s.dataDir, workspaceFile)
	if old, err := os.ReadFile(target); err == nil && json.Valid(old) {
		if err := atomicWrite(filepath.Join(s.dataDir, workspaceBackup), old); err != nil {
			log.Println("backup copy:", err)
		}
	}
	return atomicWrite(target, data)
}

func atomicWrite(target string, data []byte) error {
	tmp := target + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, target)
}

// ---- history ------------------------------------------------------------

func (s *server) historyDir(id string) (string, error) {
	if !idPattern.MatchString(id) {
		return "", errors.New("bad roadmap id")
	}
	return filepath.Join(s.dataDir, historyDirName, id), nil
}

func (s *server) snapshotTimes(dir string) []int64 {
	entries, _ := os.ReadDir(dir)
	var out []int64
	for _, e := range entries {
		if ts, err := strconv.ParseInt(strings.TrimSuffix(e.Name(), snapshotFileExt), 10, 64); err == nil {
			out = append(out, ts)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i] > out[j] })
	return out
}

func snapshotPath(dir string, ts int64) string {
	return filepath.Join(dir, strconv.FormatInt(ts, 10)+snapshotFileExt)
}

func readSnapshot(dir string, ts int64) (*snapshot, int, error) {
	data, err := os.ReadFile(snapshotPath(dir, ts))
	if err != nil {
		return nil, 0, err
	}
	var snap snapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		return nil, 0, err
	}
	return &snap, len(data), nil
}

func (s *server) listHistory(w http.ResponseWriter, id string) error {
	dir, err := s.historyDir(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []snapshotInfo{}
	for _, ts := range s.snapshotTimes(dir) {
		snap, size, err := readSnapshot(dir, ts)
		if err != nil {
			continue
		}
		var rm struct {
			Name  string `json:"name"`
			Lanes []struct {
				Subs []struct {
					Items []json.RawMessage `json:"items"`
				} `json:"subs"`
			} `json:"lanes"`
		}
		json.Unmarshal(snap.Roadmap, &rm)
		n := 0
		for _, l := range rm.Lanes {
			for _, sb := range l.Subs {
				n += len(sb.Items)
			}
		}
		out = append(out, snapshotInfo{TS: ts, Label: snap.Label, Auto: snap.Auto, Name: rm.Name, Items: n, Size: size})
	}
	writeJSON(w, out)
	return nil
}

func (s *server) addHistory(w http.ResponseWriter, r *http.Request, id string) error {
	dir, err := s.historyDir(id)
	if err != nil {
		return err
	}
	var snap snapshot
	if err := json.NewDecoder(r.Body).Decode(&snap); err != nil {
		return err
	}
	if len(snap.Roadmap) == 0 {
		return errors.New("snapshot has no roadmap")
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	times := s.snapshotTimes(dir)
	if len(times) > 0 {
		newest, _, err := readSnapshot(dir, times[0])
		if err == nil {
			same := sha256.Sum256(newest.Roadmap) == sha256.Sum256(snap.Roadmap)
			tooSoon := snap.Auto && newest.Auto && time.Since(time.UnixMilli(times[0])) < autoSnapshotGap
			if (same && snap.Auto) || tooSoon {
				writeJSON(w, map[string]any{"ok": true, "skipped": true})
				return nil
			}
		}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	snap.TS = time.Now().UnixMilli()
	data, _ := json.Marshal(snap)
	if err := atomicWrite(snapshotPath(dir, snap.TS), data); err != nil {
		return err
	}
	// Prune the oldest automatic snapshots first; labelled versions are kept.
	times = s.snapshotTimes(dir)
	for i := len(times) - 1; i >= 0 && len(times) > maxSnapshots; i-- {
		if old, _, err := readSnapshot(dir, times[i]); err == nil && !old.Auto {
			continue
		}
		os.Remove(snapshotPath(dir, times[i]))
		times = append(times[:i], times[i+1:]...)
	}
	writeJSON(w, map[string]any{"ok": true, "ts": snap.TS})
	return nil
}

func (s *server) getSnapshot(w http.ResponseWriter, id, tsText string) error {
	dir, err := s.historyDir(id)
	if err != nil {
		return err
	}
	ts, err := strconv.ParseInt(tsText, 10, 64)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	snap, _, err := readSnapshot(dir, ts)
	if err != nil {
		return err
	}
	writeJSON(w, snap)
	return nil
}

func (s *server) deleteSnapshot(w http.ResponseWriter, id, tsText string) error {
	dir, err := s.historyDir(id)
	if err != nil {
		return err
	}
	ts, err := strconv.ParseInt(tsText, 10, 64)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.Remove(snapshotPath(dir, ts)); err != nil {
		return err
	}
	writeJSON(w, map[string]any{"ok": true})
	return nil
}

// ---- full backup --------------------------------------------------------

type backupFile struct {
	App       string                `json:"app"`
	Kind      string                `json:"kind"`
	Version   string                `json:"version"`
	Exported  string                `json:"exported"`
	Workspace json.RawMessage       `json:"workspace"`
	History   map[string][]snapshot `json:"history"`
}

func (s *server) backup(w http.ResponseWriter) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	ws, err := os.ReadFile(filepath.Join(s.dataDir, workspaceFile))
	if err != nil {
		ws = []byte("null")
	}
	out := backupFile{App: appName, Kind: "backup", Version: appVersion,
		Exported: time.Now().Format(time.RFC3339), Workspace: ws, History: map[string][]snapshot{}}
	root := filepath.Join(s.dataDir, historyDirName)
	dirs, _ := os.ReadDir(root)
	for _, d := range dirs {
		if !d.IsDir() || !idPattern.MatchString(d.Name()) {
			continue
		}
		dir := filepath.Join(root, d.Name())
		for _, ts := range s.snapshotTimes(dir) {
			if snap, _, err := readSnapshot(dir, ts); err == nil {
				snap.TS = ts
				out.History[d.Name()] = append(out.History[d.Name()], *snap)
			}
		}
	}
	writeJSON(w, out)
	return nil
}

// restore replaces the workspace and merges the history carried by a backup.
func (s *server) restore(w http.ResponseWriter, r *http.Request) error {
	var in backupFile
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		return err
	}
	if in.Kind != "backup" || len(in.Workspace) == 0 || bytes.Equal(bytes.TrimSpace(in.Workspace), []byte("null")) {
		return errors.New("not a RoadMap Studio backup file")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.writeWorkspaceLocked(in.Workspace); err != nil {
		return err
	}
	restored := 0
	for id, snaps := range in.History {
		dir, err := s.historyDir(id)
		if err != nil {
			continue
		}
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
		for _, snap := range snaps {
			if snap.TS <= 0 || len(snap.Roadmap) == 0 {
				continue
			}
			if _, err := os.Stat(snapshotPath(dir, snap.TS)); err == nil {
				continue
			}
			data, _ := json.Marshal(snap)
			if err := atomicWrite(snapshotPath(dir, snap.TS), data); err == nil {
				restored++
			}
		}
	}
	writeJSON(w, map[string]any{"ok": true, "snapshots": restored})
	return nil
}

// ---- native file dialogs and clipboard ----------------------------------

type fileRequest struct {
	Name   string `json:"name"`
	Title  string `json:"title"`
	Filter string `json:"filter"` // "PNG image|*.png|All files|*.*"
	Text   string `json:"text"`
	Base64 string `json:"base64"`
}

func (s *server) saveFile(w http.ResponseWriter, r *http.Request) error {
	var req fileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return err
	}
	data := []byte(req.Text)
	if req.Base64 != "" {
		var err error
		if data, err = base64.StdEncoding.DecodeString(req.Base64); err != nil {
			return err
		}
	}
	target, ok := saveDialog(s.owner(), req.Title, req.Name, req.Filter)
	if !ok {
		writeJSON(w, map[string]any{"cancelled": true})
		return nil
	}
	if err := os.WriteFile(target, data, 0o644); err != nil {
		return err
	}
	writeJSON(w, map[string]any{"ok": true, "path": target})
	return nil
}

func (s *server) openFile(w http.ResponseWriter, r *http.Request) error {
	var req fileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return err
	}
	source, ok := openDialog(s.owner(), req.Title, req.Filter)
	if !ok {
		writeJSON(w, map[string]any{"cancelled": true})
		return nil
	}
	info, err := os.Stat(source)
	if err != nil {
		return err
	}
	if info.Size() > maxBody {
		return errors.New("file is too large")
	}
	data, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	writeJSON(w, map[string]any{"ok": true, "name": filepath.Base(source), "text": string(data)})
	return nil
}

func (s *server) clipboardImage(w http.ResponseWriter, r *http.Request) error {
	data, err := io.ReadAll(r.Body)
	if err != nil {
		return err
	}
	if err := copyPNGToClipboard(data); err != nil {
		return err
	}
	writeJSON(w, map[string]any{"ok": true})
	return nil
}

// waitForBrowserExit keeps the process alive in browser-fallback mode until
// the page stops pinging.
func (s *server) waitForBrowserExit(idle time.Duration) {
	start := time.Now()
	for {
		time.Sleep(5 * time.Second)
		s.mu.Lock()
		pinged, last := s.pinged, s.lastPing
		s.mu.Unlock()
		if !pinged && time.Since(start) > idle {
			return
		}
		if pinged && time.Since(last) > idle+browserPingGrace {
			return
		}
	}
}
