// RoadMap Studio - a single-file Windows roadmap / swimlane timeline designer.
//
// The UI is a web app embedded in the executable and shown in a WebView2
// window. A loopback-only HTTP server in the same process owns storage:
// the workspace and its version history live under %ProgramData%\RoadMapStudio
// (macOS: ~/Library/Application Support/RoadMapStudio).
package main

import (
	"crypto/rand"
	"embed"
	"encoding/hex"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// appVersion is a var so a build can stamp it (-X main.appVersion=...).
var appVersion = "1.4.3"

const (
	appName    = "RoadMap Studio"
	appDirName = "RoadMapStudio"
)

//go:embed ui
var uiFiles embed.FS

func main() {
	dev := flag.Bool("dev", false, "serve the UI on a fixed port without a window or token (development)")
	port := flag.Int("port", 0, "port to listen on (default: random)")
	dataFlag := flag.String("data", "", "data directory (default: the per-platform application data folder)")
	flag.BoolVar(&afterUpdate, "after-update", false, "started by the previous copy after a self-update")
	flag.Parse()
	cleanOldExecutable()

	dataDir, err := resolveDataDir(*dataFlag)
	if err != nil {
		fatal("Cannot create a data folder: " + err.Error())
	}
	if !*dev && !acquireSingleInstance(dataDir) {
		return
	}
	if lf, err := os.OpenFile(filepath.Join(dataDir, "app.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644); err == nil {
		log.SetOutput(lf)
	}

	token := ""
	if !*dev {
		b := make([]byte, 24)
		if _, err := rand.Read(b); err != nil {
			fatal("Cannot create a session token: " + err.Error())
		}
		token = hex.EncodeToString(b)
	}

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		fatal("Cannot open a local port: " + err.Error())
	}
	addr := ln.Addr().String()

	sub, _ := fs.Sub(uiFiles, "ui")
	if *dev {
		if _, err := os.Stat("ui/index.html"); err == nil {
			sub = os.DirFS("ui") // live files while developing
		}
	}
	srv := newServer(dataDir, token, addr, sub, *dev)
	go func() {
		if err := http.Serve(ln, srv); err != nil {
			log.Println("http:", err)
		}
	}()

	url := "http://" + addr + "/"
	if token != "" {
		url += "?t=" + token
	}
	if *dev {
		fmt.Println("dev server on", url, "data in", dataDir)
		select {}
	}

	defer srv.releaseAllLocks()
	if !runWindow(url, srv) {
		// No embedded window (macOS, Linux, or Windows without WebView2): show the
		// UI in the browser and stay alive for as long as the page keeps pinging.
		log.Println("no embedded window - using the browser")
		srv.native, srv.browser = false, true
		announceInstance(dataDir, url)
		defer forgetInstance(dataDir)
		openBrowser(url)
		srv.waitForBrowserExit(3 * time.Minute)
	}
}

func resolveDataDir(override string) (string, error) {
	candidates := []string{}
	if override != "" {
		candidates = append(candidates, override)
	} else {
		candidates = dataDirCandidates()
	}
	var lastErr error
	for _, dir := range candidates {
		_, statErr := os.Stat(dir)
		if err := os.MkdirAll(filepath.Join(dir, "history"), 0o755); err != nil {
			lastErr = err
			continue
		}
		probe := filepath.Join(dir, ".write-test")
		if err := os.WriteFile(probe, []byte("ok"), 0o644); err != nil {
			lastErr = err
			continue
		}
		os.Remove(probe)
		if os.IsNotExist(statErr) && override == "" {
			shareWithAllUsers(dir)
		}
		return dir, nil
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no candidate folder")
	}
	return "", lastErr
}
