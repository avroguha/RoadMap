//go:build !windows

// macOS and Linux: there is no embedded window here (a native one needs the
// platform SDK and cgo). The same local engine runs and the UI is shown in the
// user's browser - as a chromeless app window when Chrome or Edge is installed.
// File export/import and "Copy image" use the browser's own download, file
// picker and clipboard.
package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

const instanceFile = "instance.json"

func dataDirCandidates() []string {
	home, _ := os.UserHomeDir()
	if runtime.GOOS == "darwin" {
		return []string{filepath.Join(home, "Library", "Application Support", appDirName)}
	}
	if x := os.Getenv("XDG_DATA_HOME"); x != "" {
		return []string{filepath.Join(x, appDirName)}
	}
	return []string{filepath.Join(home, ".local", "share", appDirName)}
}

func fatal(msg string) {
	log.Println("fatal:", msg)
	if runtime.GOOS == "darwin" {
		exec.Command("osascript", "-e", `display alert "RoadMap Studio" message `+strconvQuote(msg)).Run()
	}
	panic(msg)
}

func strconvQuote(s string) string {
	b, _ := json.Marshal(s) // AppleScript string literals use the same escapes for quotes and backslashes
	return string(b)
}

type instanceInfo struct {
	URL string `json:"url"`
	PID int    `json:"pid"`
}

// acquireSingleInstance returns false when a copy is already serving this data
// folder; that copy's page is opened instead of starting a second engine.
func acquireSingleInstance(dataDir string) bool {
	data, err := os.ReadFile(filepath.Join(dataDir, instanceFile))
	if err != nil {
		return true
	}
	var info instanceInfo
	if json.Unmarshal(data, &info) != nil || info.URL == "" {
		return true
	}
	client := http.Client{Timeout: 1500 * time.Millisecond}
	resp, err := client.Get(info.URL)
	if err != nil {
		return true // stale file from a copy that is gone
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return true
	}
	if afterUpdate {
		// The copy that installed us is shutting down; give it a moment.
		for i := 0; i < 40; i++ {
			time.Sleep(300 * time.Millisecond)
			if r, err := client.Get(info.URL); err != nil {
				return true
			} else {
				r.Body.Close()
			}
		}
	}
	openBrowser(info.URL)
	return false
}

func announceInstance(dataDir, url string) {
	data, _ := json.Marshal(instanceInfo{URL: url, PID: os.Getpid()})
	// The URL carries the session token, so keep the file private.
	if err := os.WriteFile(filepath.Join(dataDir, instanceFile), data, 0o600); err != nil {
		log.Println("instance file:", err)
	}
}

func forgetInstance(dataDir string) { os.Remove(filepath.Join(dataDir, instanceFile)) }

func runWindow(string, *server) bool { return false }

func shareWithAllUsers(string) {}

// openBrowser prefers a chromeless "app" window, falling back to the default browser.
func openBrowser(url string) {
	if runtime.GOOS == "darwin" {
		for _, app := range []string{"Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium"} {
			if _, err := os.Stat("/Applications/" + app + ".app"); err == nil {
				if exec.Command("open", "-na", app, "--args", "--app="+url, "--new-window").Start() == nil {
					return
				}
			}
		}
		exec.Command("open", url).Start()
		return
	}
	for _, bin := range []string{"google-chrome", "chromium", "chromium-browser", "microsoft-edge"} {
		if path, err := exec.LookPath(bin); err == nil {
			if exec.Command(path, "--app="+url).Start() == nil {
				return
			}
		}
	}
	exec.Command("xdg-open", url).Start()
}

func hiddenCommand(name string, args ...string) *exec.Cmd { return exec.Command(name, args...) }

func openFolder(dir string) {
	if runtime.GOOS == "darwin" {
		exec.Command("open", dir).Start()
		return
	}
	exec.Command("xdg-open", dir).Start()
}

var errNoNative = errors.New("not available on this platform - the browser handles it")

func saveDialog(uintptr, string, string, string) (string, bool) { return "", false }
func openDialog(uintptr, string, string) (string, bool)         { return "", false }
func copyPNGToClipboard([]byte) error                           { return errNoNative }
