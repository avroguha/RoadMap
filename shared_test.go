package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSharedLockSaveAndConflict(t *testing.T) {
	s := newTestServer(t)
	path := filepath.Join(t.TempDir(), "plan.roadmap.json")
	q := strconvQuoteJSON(path)

	code, body := call(t, s, "POST", "/api/shared/create", `{"path":`+q+`,"roadmap":{"name":"Plan","lanes":[]}}`, nil)
	if code != 200 || !strings.Contains(body, `"held":true`) || !strings.Contains(body, `"rev":1`) {
		t.Fatalf("create: %d %s", code, body)
	}
	if _, err := os.Stat(lockPath(path)); err != nil {
		t.Fatal("lock file missing after create")
	}
	if code, body := call(t, s, "POST", "/api/shared/create", `{"path":`+q+`,"roadmap":{}}`, nil); code == 200 {
		t.Fatalf("create over existing must fail: %s", body)
	}
	// Save with the right rev succeeds and bumps it; a stale rev is a conflict.
	_, body = call(t, s, "POST", "/api/shared/save", `{"path":`+q+`,"rev":1,"roadmap":{"name":"Plan v2","lanes":[]}}`, nil)
	if !strings.Contains(body, `"ok":true`) || !strings.Contains(body, `"rev":2`) {
		t.Fatalf("save: %s", body)
	}
	_, body = call(t, s, "POST", "/api/shared/save", `{"path":`+q+`,"rev":1,"roadmap":{}}`, nil)
	if !strings.Contains(body, `"reason":"conflict"`) || !strings.Contains(body, `"rev":2`) {
		t.Fatalf("conflict not detected: %s", body)
	}
	// Release: the lock file goes away; a save is then refused.
	call(t, s, "POST", "/api/shared/release", `{"path":`+q+`}`, nil)
	if _, err := os.Stat(lockPath(path)); !os.IsNotExist(err) {
		t.Fatal("lock file still there after release")
	}
	if _, body := call(t, s, "POST", "/api/shared/save", `{"path":`+q+`,"rev":2,"roadmap":{}}`, nil); !strings.Contains(body, `"reason":"lock"`) {
		t.Fatalf("save without lock: %s", body)
	}
}

func TestSharedStaleLockTakeover(t *testing.T) {
	s := newTestServer(t)
	path := filepath.Join(t.TempDir(), "plan.roadmap.json")
	q := strconvQuoteJSON(path)
	writeShared(path, &sharedFile{Rev: 1, Roadmap: json.RawMessage(`{"name":"x","lanes":[]}`)})
	// Somebody else's lock, heartbeat long ago.
	other := lockInfo{User: "priya", Machine: "LT-9", PID: 1, Since: "2026-01-01T00:00:00Z", Heartbeat: time.Now().Add(-10 * time.Minute).UTC().Format(time.RFC3339)}
	data, _ := json.Marshal(other)
	os.WriteFile(lockPath(path), data, 0o644)

	_, body := call(t, s, "POST", "/api/shared/open", `{"path":`+q+`,"edit":true}`, nil)
	if !strings.Contains(body, `"held":false`) || !strings.Contains(body, `"stale":true`) || !strings.Contains(body, `"user":"priya"`) {
		t.Fatalf("stale lock should be reported, not taken silently: %s", body)
	}
	_, body = call(t, s, "POST", "/api/shared/lock", `{"path":`+q+`,"takeover":true}`, nil)
	if !strings.Contains(body, `"held":true`) {
		t.Fatalf("takeover of stale lock failed: %s", body)
	}
	// A live lock held by someone else cannot be taken over.
	s.releaseLock(path)
	other.Heartbeat = time.Now().UTC().Format(time.RFC3339)
	data, _ = json.Marshal(other)
	os.WriteFile(lockPath(path), data, 0o644)
	_, body = call(t, s, "POST", "/api/shared/lock", `{"path":`+q+`,"takeover":true}`, nil)
	if strings.Contains(body, `"held":true`) {
		t.Fatalf("live lock was stolen: %s", body)
	}
	if code, _ := call(t, s, "POST", "/api/shared/open", `{"path":"relative.json"}`, nil); code == 200 {
		t.Fatal("relative path accepted")
	}
}
