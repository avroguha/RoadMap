// agegate enforces the 72-hour rule: nothing published in the last 72 hours
// is built into RoadMap Studio.
//
//	go run ./tools/agegate -refresh        (at home) look up the publish time of
//	                                        every Go module in the build and of every
//	                                        pinned image; write the two cache files
//	agegate -check -hours 72               (in the Docker build) read the cache ONLY -
//	                                        the work network cannot reach the public
//	                                        registries - and fail on any module that is
//	                                        too new or not in the cache
//
// go-publish-times.json and image-digests.json are committed. A pin may only
// move to something that was already 72 hours old when it was looked up.
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	modCache   = "go-publish-times.json"
	imageCache = "image-digests.json"
)

type modEntry struct {
	Published time.Time `json:"published"`
}

type imageEntry struct {
	Created time.Time `json:"created"`
	Checked time.Time `json:"checked"`
}

func main() {
	refresh := flag.Bool("refresh", false, "look up publish times and rewrite the cache files")
	check := flag.Bool("check", false, "fail if any module in the build is younger than -hours")
	hours := flag.Float64("hours", 72, "minimum age in hours")
	flag.Parse()
	var err error
	switch {
	case *refresh:
		err = doRefresh()
	case *check:
		err = doCheck(time.Duration(*hours * float64(time.Hour)))
	default:
		err = fmt.Errorf("give -refresh or -check")
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "agegate:", err)
		os.Exit(1)
	}
}

func buildList() ([]string, error) {
	out, err := exec.Command("go", "list", "-m", "-f", "{{if not .Main}}{{.Path}}@{{.Version}}{{end}}", "all").Output()
	if err != nil {
		return nil, fmt.Errorf("go list -m all: %w", err)
	}
	var mods []string
	sc := bufio.NewScanner(strings.NewReader(string(out)))
	for sc.Scan() {
		if l := strings.TrimSpace(sc.Text()); l != "" {
			mods = append(mods, l)
		}
	}
	return mods, nil
}

func doCheck(minAge time.Duration) error {
	raw, err := os.ReadFile(modCache)
	if err != nil {
		return fmt.Errorf("%s missing - run `go run ./tools/agegate -refresh` at home and commit it", modCache)
	}
	cache := map[string]modEntry{}
	if err := json.Unmarshal(raw, &cache); err != nil {
		return err
	}
	mods, err := buildList()
	if err != nil {
		return err
	}
	var bad []string
	for _, m := range mods {
		e, ok := cache[m]
		switch {
		case !ok:
			bad = append(bad, m+": publish time unknown (not in "+modCache+") - refused, not waved through")
		case time.Since(e.Published) < minAge:
			bad = append(bad, fmt.Sprintf("%s: published %s, younger than %s", m, e.Published.Format(time.RFC3339), minAge))
		}
	}
	if len(bad) > 0 {
		return fmt.Errorf("release-age gate failed - wait, or pin an older version; never bypass:\n  %s", strings.Join(bad, "\n  "))
	}
	fmt.Printf("agegate: %d Go modules, every one published more than %s ago\n", len(mods), minAge)
	return nil
}

func doRefresh() error {
	mods, err := buildList()
	if err != nil {
		return err
	}
	cache := map[string]modEntry{}
	for _, m := range mods {
		path, ver, _ := strings.Cut(m, "@")
		var info struct{ Time time.Time }
		if err := getJSON(fmt.Sprintf("https://proxy.golang.org/%s/@v/%s.info", escapePath(path), ver), nil, &info); err != nil {
			return fmt.Errorf("%s: %w", m, err)
		}
		cache[m] = modEntry{Published: info.Time.UTC()}
	}
	if err := writeJSON(modCache, cache); err != nil {
		return err
	}
	fmt.Printf("agegate: %d modules written to %s\n", len(cache), modCache)

	pins, err := pinnedImages()
	if err != nil {
		return err
	}
	images := map[string]imageEntry{}
	for _, p := range pins {
		created, err := imageCreated(p)
		if err != nil {
			return fmt.Errorf("%s: %w", p, err)
		}
		images[p] = imageEntry{Created: created.UTC(), Checked: time.Now().UTC().Truncate(time.Second)}
		age := time.Since(created).Round(time.Hour)
		fmt.Printf("agegate: %s built %s (%s ago)\n", p, created.Format("2006-01-02"), age)
	}
	return writeJSON(imageCache, images)
}

// Module paths with capitals are case-escaped on the proxy (!x for X).
func escapePath(p string) string {
	var b strings.Builder
	for _, r := range p {
		if r >= 'A' && r <= 'Z' {
			b.WriteByte('!')
			r += 'a' - 'A'
		}
		b.WriteRune(r)
	}
	return b.String()
}

var pinRE = regexp.MustCompile(`([a-z0-9][a-z0-9._/-]*:[A-Za-z0-9._-]+)@(sha256:[0-9a-f]{64})`)

// pinnedImages finds every name:tag@sha256 in the deployment files.
func pinnedImages() ([]string, error) {
	seen := map[string]bool{}
	for _, f := range []string{"Dockerfile", "docker-compose.yml"} {
		b, err := os.ReadFile(f)
		if err != nil {
			return nil, err
		}
		for _, m := range pinRE.FindAllStringSubmatch(string(b), -1) {
			name := strings.TrimPrefix(m[1], "registry.avro.com/")
			seen[name+"@"+m[2]] = true
		}
	}
	var out []string
	for k := range seen {
		out = append(out, k)
	}
	sort.Strings(out)
	return out, nil
}

// imageCreated reads the image's build time from Docker Hub's registry:
// manifest list -> linux/amd64 manifest -> config blob -> created.
func imageCreated(pin string) (time.Time, error) {
	ref, digest, _ := strings.Cut(pin, "@")
	repo, _, _ := strings.Cut(ref, ":")
	if !strings.Contains(repo, "/") {
		repo = "library/" + repo
	}
	var tok struct{ Token string }
	if err := getJSON("https://auth.docker.io/token?service=registry.docker.io&scope=repository:"+repo+":pull", nil, &tok); err != nil {
		return time.Time{}, err
	}
	hdr := map[string]string{"Authorization": "Bearer " + tok.Token,
		"Accept": "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"}
	var m struct {
		Manifests []struct {
			Digest   string
			Platform struct{ Architecture, OS string }
		}
		Config struct{ Digest string }
	}
	if err := getJSON("https://registry-1.docker.io/v2/"+repo+"/manifests/"+digest, hdr, &m); err != nil {
		return time.Time{}, err
	}
	if len(m.Manifests) > 0 {
		for _, x := range m.Manifests {
			if x.Platform.OS == "linux" && x.Platform.Architecture == "amd64" {
				if err := getJSON("https://registry-1.docker.io/v2/"+repo+"/manifests/"+x.Digest, hdr, &m); err != nil {
					return time.Time{}, err
				}
				break
			}
		}
	}
	if m.Config.Digest == "" {
		return time.Time{}, fmt.Errorf("no linux/amd64 image config found")
	}
	var cfg struct{ Created time.Time }
	if err := getJSON("https://registry-1.docker.io/v2/"+repo+"/blobs/"+m.Config.Digest, hdr, &cfg); err != nil {
		return time.Time{}, err
	}
	return cfg.Created, nil
}

func getJSON(url string, hdr map[string]string, into any) error {
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	c := &http.Client{Timeout: 30 * time.Second}
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: %s", url, resp.Status)
	}
	return json.Unmarshal(body, into)
}

func writeJSON(path string, v any) error {
	b, _ := json.MarshalIndent(v, "", "  ")
	return os.WriteFile(filepath.Clean(path), append(b, '\n'), 0o644)
}
