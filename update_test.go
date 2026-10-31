package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNewerVersion(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{{"1.2.1", "1.2.0", true}, {"1.2.0", "1.2.1", false}, {"1.10.0", "1.9.9", true}, {"2", "1.9.9", true}, {"1.2.1", "1.2.1", false}, {"1.2", "1.2.0", false}}
	for _, c := range cases {
		if got := newerVersion(c.a, c.b); got != c.want {
			t.Errorf("newerVersion(%q,%q)=%v want %v", c.a, c.b, got, c.want)
		}
	}
}

// The check endpoint reads a manifest from a folder location and reports
// whether it is newer, and refuses a damaged download on apply.
func TestUpdateCheckFromFolder(t *testing.T) {
	s := newTestServer(t)
	loc := t.TempDir()
	payload := []byte("not really an exe")
	sum := sha256.Sum256(payload)
	m := manifest{Version: "99.0.0", Notes: "big", Files: map[string]manifestFile{platformKey(): {Name: "RoadMapStudio.exe", SHA256: hex.EncodeToString(sum[:])}}}
	data, _ := json.Marshal(m)
	os.WriteFile(filepath.Join(loc, "latest.json"), data, 0o644)
	os.WriteFile(filepath.Join(loc, "RoadMapStudio.exe"), []byte("tampered"), 0o644)

	if code, _ := call(t, s, "PUT", "/api/update/settings", `{"location":`+strconvQuoteJSON(loc)+`}`, nil); code != 200 {
		t.Fatalf("settings: %d", code)
	}
	code, body := call(t, s, "POST", "/api/update/check", "", nil)
	if code != 200 || !strings.Contains(body, `"available":true`) || !strings.Contains(body, `"latest":"99.0.0"`) {
		t.Fatalf("check: %d %s", code, body)
	}
	// The file on the share does not match the manifest's checksum: must not install.
	if code, body := call(t, s, "POST", "/api/update/apply", "", nil); code == 200 || !strings.Contains(body, "checksum") {
		t.Fatalf("apply with bad checksum: %d %s", code, body)
	}
	if _, body := call(t, s, "GET", "/api/update/settings", "", nil); !strings.Contains(body, `"lastCheck":`) || strings.Contains(body, `"lastCheck":0`) {
		t.Fatalf("lastCheck not recorded: %s", body)
	}
}

func strconvQuoteJSON(s string) string { b, _ := json.Marshal(s); return string(b) }
