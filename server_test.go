package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

const testHost = "127.0.0.1:5999"

func call(t *testing.T, s *server, method, path, body string, headers map[string]string) (int, string) {
	t.Helper()
	req := httptest.NewRequest(method, "http://"+testHost+path, strings.NewReader(body))
	req.Header.Set("X-Token", "secret")
	for k, v := range headers {
		if k == "Host" {
			req.Host = v
		} else {
			req.Header.Set(k, v)
		}
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	out, _ := io.ReadAll(rec.Result().Body)
	return rec.Code, string(out)
}

func newTestServer(t *testing.T) *server {
	ui := fstest.MapFS{"index.html": {Data: []byte("<html></html>")}, "app.js": {Data: []byte("1")}}
	return newServer(t.TempDir(), "secret", testHost, ui, false)
}

func TestTokenAndHostAreEnforced(t *testing.T) {
	s := newTestServer(t)
	if code, _ := call(t, s, "GET", "/api/info", "", map[string]string{"X-Token": "wrong"}); code != http.StatusUnauthorized {
		t.Fatalf("wrong token: got %d", code)
	}
	if code, _ := call(t, s, "GET", "/api/info", "", map[string]string{"Host": "evil.example:5999"}); code != http.StatusForbidden {
		t.Fatalf("foreign host: got %d", code)
	}
	if code, _ := call(t, s, "GET", "/app.js", "", nil); code != http.StatusOK {
		t.Fatalf("static: got %d", code)
	}
}

func TestWorkspaceRoundTripKeepsBackup(t *testing.T) {
	s := newTestServer(t)
	if _, body := call(t, s, "GET", "/api/workspace", "", nil); strings.TrimSpace(body) != "null" {
		t.Fatalf("empty workspace: got %q", body)
	}
	call(t, s, "PUT", "/api/workspace", `{"v":1}`, nil)
	call(t, s, "PUT", "/api/workspace", `{"v":2}`, nil)
	if _, body := call(t, s, "GET", "/api/workspace", "", nil); body != `{"v":2}` {
		t.Fatalf("got %q", body)
	}
	bak, _ := os.ReadFile(filepath.Join(s.dataDir, workspaceBackup))
	if string(bak) != `{"v":1}` {
		t.Fatalf("backup: got %q", bak)
	}
	if code, _ := call(t, s, "PUT", "/api/workspace", `{broken`, nil); code == http.StatusOK {
		t.Fatal("invalid JSON must be refused")
	}
	// A corrupted main file falls back to the backup.
	os.WriteFile(filepath.Join(s.dataDir, workspaceFile), []byte("{trunc"), 0o644)
	if _, body := call(t, s, "GET", "/api/workspace", "", nil); body != `{"v":1}` {
		t.Fatalf("fallback: got %q", body)
	}
}

func TestHistoryBackupAndRestore(t *testing.T) {
	s := newTestServer(t)
	call(t, s, "PUT", "/api/workspace", `{"roadmaps":[]}`, nil)
	snap := `{"label":"v1","auto":false,"roadmap":{"name":"R","lanes":[{"subs":[{"items":[{},{}]}]}]}}`
	if code, body := call(t, s, "POST", "/api/history/abc123", snap, nil); code != 200 {
		t.Fatalf("add: %d %s", code, body)
	}
	// An identical automatic snapshot is skipped.
	_, body := call(t, s, "POST", "/api/history/abc123", strings.Replace(snap, `"auto":false`, `"auto":true`, 1), nil)
	if !strings.Contains(body, "skipped") {
		t.Fatalf("duplicate auto snapshot not skipped: %s", body)
	}
	if code, _ := call(t, s, "POST", "/api/history/..%2Fevil", snap, nil); code == 200 {
		t.Fatal("path traversal id accepted")
	}
	var list []snapshotInfo
	_, body = call(t, s, "GET", "/api/history/abc123", "", nil)
	json.Unmarshal([]byte(body), &list)
	if len(list) != 1 || list[0].Items != 2 || list[0].Label != "v1" {
		t.Fatalf("list: %s", body)
	}

	_, backup := call(t, s, "GET", "/api/backup", "", nil)
	fresh := newTestServer(t)
	if code, body := call(t, fresh, "POST", "/api/restore", backup, nil); code != 200 || !strings.Contains(body, `"snapshots":1`) {
		t.Fatalf("restore: %d %s", code, body)
	}
	if _, body := call(t, fresh, "GET", "/api/workspace", "", nil); body != `{"roadmaps":[]}` {
		t.Fatalf("restored workspace: %q", body)
	}
	if code, _ := call(t, fresh, "POST", "/api/restore", `{"kind":"roadmap"}`, nil); code == 200 {
		t.Fatal("a non-backup file must be refused")
	}
}
