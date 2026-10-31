package main

// Self-update. A "location" (https URL or a folder / UNC share) holds
// latest.json plus the release files that build.ps1 writes into dist\.
// Checking reads latest.json; updating downloads this platform's file,
// verifies its SHA-256, swaps the running executable and relaunches.

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Set at build time: -ldflags "-X main.defaultUpdateLocation=https://cdn.example.com/roadmap"
var defaultUpdateLocation = ""

// afterUpdate is set by --after-update: the previous copy is still shutting
// down, so single-instance checks retry for a while instead of giving up.
var afterUpdate = false

const configFile = "config.json"

type appConfig struct {
	UpdateLocation string `json:"updateLocation"`
	LastCheck      int64  `json:"lastCheck"`
}

type manifest struct {
	Version  string                  `json:"version"`
	Released string                  `json:"released"`
	Notes    string                  `json:"notes"`
	Files    map[string]manifestFile `json:"files"`
}

type manifestFile struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
}

func (s *server) readConfig() appConfig {
	var c appConfig
	if data, err := os.ReadFile(filepath.Join(s.dataDir, configFile)); err == nil {
		json.Unmarshal(data, &c)
	}
	return c
}

func (s *server) writeConfig(c appConfig) error {
	data, _ := json.MarshalIndent(c, "", "  ")
	return atomicWrite(filepath.Join(s.dataDir, configFile), data)
}

func (s *server) updateLocation() (loc string, builtIn bool) {
	if c := s.readConfig(); strings.TrimSpace(c.UpdateLocation) != "" {
		return strings.TrimSpace(c.UpdateLocation), false
	}
	return defaultUpdateLocation, true
}

func platformKey() string {
	switch runtime.GOOS {
	case "windows":
		return "windows-" + runtime.GOARCH
	case "darwin":
		return "darwin"
	}
	return runtime.GOOS + "-" + runtime.GOARCH
}

// fetchFrom reads name relative to location, which is either an http(s) base
// URL or a folder (local, mapped drive or \\server\share).
func fetchFrom(location, name string) ([]byte, error) {
	if strings.HasPrefix(location, "http://") || strings.HasPrefix(location, "https://") {
		client := http.Client{Timeout: 3 * time.Minute}
		url := strings.TrimRight(location, "/") + "/" + name
		req, _ := http.NewRequest(http.MethodGet, url, nil)
		req.Header.Set("Cache-Control", "no-cache")
		resp, err := client.Get(req.URL.String())
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("%s: HTTP %d", name, resp.StatusCode)
		}
		return io.ReadAll(io.LimitReader(resp.Body, 200<<20))
	}
	return os.ReadFile(filepath.Join(location, name))
}

func fetchManifest(location string) (*manifest, error) {
	data, err := fetchFrom(location, "latest.json")
	if err != nil {
		return nil, err
	}
	var m manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, errors.New("latest.json is not valid")
	}
	if m.Version == "" {
		return nil, errors.New("latest.json has no version")
	}
	return &m, nil
}

// newerVersion reports whether a is a higher "1.2.3"-style version than b.
func newerVersion(a, b string) bool {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(strings.TrimSpace(pa[i]))
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(strings.TrimSpace(pb[i]))
		}
		if x != y {
			return x > y
		}
	}
	return false
}

// ---- API ----------------------------------------------------------------

func (s *server) updateAPI(w http.ResponseWriter, r *http.Request, action string) error {
	switch {
	case action == "settings" && r.Method == http.MethodGet:
		loc, builtIn := s.updateLocation()
		c := s.readConfig()
		writeJSON(w, map[string]any{"location": loc, "builtIn": builtIn, "lastCheck": c.LastCheck, "current": appVersion, "platform": platformKey()})
	case action == "settings" && r.Method == http.MethodPut:
		var in struct {
			Location string `json:"location"`
		}
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			return err
		}
		c := s.readConfig()
		c.UpdateLocation = strings.TrimSpace(in.Location)
		if err := s.writeConfig(c); err != nil {
			return err
		}
		writeJSON(w, map[string]any{"ok": true})
	case action == "check" && r.Method == http.MethodPost:
		loc, _ := s.updateLocation()
		if loc == "" {
			writeJSON(w, map[string]any{"configured": false, "current": appVersion})
			return nil
		}
		m, err := fetchManifest(loc)
		c := s.readConfig()
		c.LastCheck = time.Now().UnixMilli()
		s.writeConfig(c)
		if err != nil {
			writeJSON(w, map[string]any{"configured": true, "current": appVersion, "error": err.Error()})
			return nil
		}
		f, ok := m.Files[platformKey()]
		writeJSON(w, map[string]any{"configured": true, "current": appVersion, "latest": m.Version, "released": m.Released, "notes": m.Notes,
			"available": newerVersion(m.Version, appVersion) && ok, "file": f.Name, "platformMissing": !ok})
	case action == "apply" && r.Method == http.MethodPost:
		loc, _ := s.updateLocation()
		if loc == "" {
			return errors.New("no update location is set")
		}
		m, err := fetchManifest(loc)
		if err != nil {
			return err
		}
		f, ok := m.Files[platformKey()]
		if !ok {
			return errors.New("the update has no build for " + platformKey())
		}
		data, err := fetchFrom(loc, f.Name)
		if err != nil {
			return err
		}
		if f.SHA256 != "" {
			sum := sha256.Sum256(data)
			if !strings.EqualFold(hex.EncodeToString(sum[:]), f.SHA256) {
				return errors.New("the downloaded file is damaged (checksum mismatch) - not installed")
			}
		}
		if err := installUpdate(data, f.Name); err != nil {
			return err
		}
		log.Println("updated to", m.Version, "- restarting")
		writeJSON(w, map[string]any{"ok": true, "version": m.Version})
		go func() {
			time.Sleep(400 * time.Millisecond)
			s.releaseAllLocks()
			forgetInstance(s.dataDir)
			relaunch()
			os.Exit(0)
		}()
	default:
		http.NotFound(w, r)
	}
	return nil
}

// ---- installing ---------------------------------------------------------

// installUpdate swaps the running executable for data. A running program can
// be renamed but not overwritten, so the old file is moved aside first and
// removed on the next start (see cleanOldExecutable).
// installedExe is the path the new copy must be started from: after the
// rename, os.Executable() reports the ".old" name on every platform.
var installedExe string

func installUpdate(data []byte, name string) error {
	if strings.HasSuffix(strings.ToLower(name), ".zip") {
		var err error
		if data, err = executableFromZip(data); err != nil {
			return err
		}
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	exe, _ = filepath.EvalSymlinks(exe)
	old := exe + ".old"
	os.Remove(old)
	if err := os.Rename(exe, old); err != nil {
		return fmt.Errorf("cannot replace %s (is the folder read-only?): %v", filepath.Base(exe), err)
	}
	if err := os.WriteFile(exe, data, 0o755); err != nil {
		os.Rename(old, exe)
		return err
	}
	os.Chmod(exe, 0o755)
	installedExe = exe
	return nil
}

// executableFromZip pulls the app binary out of the macOS bundle zip.
func executableFromZip(data []byte) ([]byte, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, err
	}
	for _, f := range zr.File {
		if strings.HasSuffix(f.Name, "/Contents/MacOS/RoadMapStudio") {
			rc, err := f.Open()
			if err != nil {
				return nil, err
			}
			defer rc.Close()
			return io.ReadAll(rc)
		}
	}
	return nil, errors.New("the zip does not contain the application")
}

func relaunch() {
	exe := installedExe
	if runtime.GOOS == "darwin" {
		if i := strings.Index(exe, ".app/Contents/MacOS/"); i >= 0 {
			exec.Command("open", "-n", exe[:i+4], "--args", "--after-update").Start()
			return
		}
	}
	hiddenCommand(exe, "--after-update").Start()
}

// cleanOldExecutable removes the file left behind by the previous update.
func cleanOldExecutable() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	exe, _ = filepath.EvalSymlinks(exe)
	go func() {
		for i := 0; i < 20; i++ {
			if err := os.Remove(exe + ".old"); err == nil || os.IsNotExist(err) {
				return
			}
			time.Sleep(500 * time.Millisecond)
		}
	}()
}
