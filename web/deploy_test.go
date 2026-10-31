package main

// Guards for the deployment files. Every one of these broke a real build
// once; they keep the build reproducible, unprivileged and supply-chain gated,
// and keep every external location overridable from the env file.

import (
	"bufio"
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"
)

func readFile(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func envFile(t *testing.T, p string) map[string]string {
	t.Helper()
	m := map[string]string{}
	sc := bufio.NewScanner(strings.NewReader(readFile(t, p)))
	for sc.Scan() {
		l := strings.TrimSpace(strings.TrimRight(sc.Text(), "\r"))
		if l == "" || strings.HasPrefix(l, "#") {
			continue
		}
		k, v, ok := strings.Cut(l, "=")
		if !ok {
			t.Fatalf("%s: line without '=': %q", p, l)
		}
		m[k] = v
	}
	return m
}

var locationKeys = []string{"IMAGE_REGISTRY", "GOPROXY", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"}

const (
	defaultGoProxy = "https://proxy.golang.org,direct"
	defaultNoProxy = "localhost,127.0.0.1"
)

// Public defaults in every stage, nothing site-specific baked in, and nothing
// that a site's mirror or proxy cannot replace through the build arguments.
func TestDockerfileDefaultsToPublicLocations(t *testing.T) {
	df := readFile(t, "Dockerfile")
	if !strings.Contains(df, "ARG IMAGE_REGISTRY=\n") {
		t.Error("IMAGE_REGISTRY must default to empty (plain Docker Hub paths)")
	}
	stages := regexp.MustCompile(`(?m)^FROM `).Split(df, -1)[1:]
	if len(stages) != 2 {
		t.Fatalf("expected 2 stages, found %d", len(stages))
	}
	for i, st := range stages {
		for _, want := range []string{
			"ARG HTTP_PROXY=\n", "ARG HTTPS_PROXY=\n", "ARG NO_PROXY=" + defaultNoProxy + "\n",
			"ARG http_proxy=${HTTP_PROXY}", "ARG https_proxy=${HTTPS_PROXY}", "ARG no_proxy=${NO_PROXY}",
			"ARG GOPROXY=" + defaultGoProxy + "\n",
		} {
			if !strings.Contains(st, want) {
				t.Errorf("stage %d: missing %q (ARG is scoped to one stage)", i+1, want)
			}
		}
	}
	final := stages[len(stages)-1]
	for _, want := range []string{"ENV GOPROXY= HTTP_PROXY= HTTPS_PROXY= NO_PROXY=", "ENV http_proxy= https_proxy= no_proxy="} {
		if !strings.Contains(final, want) {
			t.Errorf("runtime stage must clear the build-time locations: %q", want)
		}
	}
	for _, line := range regexp.MustCompile(`(?m)^FROM .*$`).FindAllString(df, -1) {
		if !strings.HasPrefix(line, "FROM ${IMAGE_REGISTRY}") {
			t.Errorf("image not pulled through IMAGE_REGISTRY: %s", line)
		}
	}
	if !regexp.MustCompile(`RUN go mod download && go run \./tools/agegate -check -hours 72`).MatchString(df) {
		t.Error("the 72-hour gate must run right after go mod download, on the same RUN line")
	}
	code := regexp.MustCompile(`(?m)^\s*#.*$`).ReplaceAllString(df, "") // comments may name what is banned
	if strings.HasPrefix(strings.TrimSpace(df), "# syntax=") {
		t.Error("a # syntax= directive needs BuildKit; the file must build on the legacy builder too")
	}
	for _, bad := range []string{"RUN --mount", "COPY --chmod", "COPY --link", "<<EOF", "<<'EOF'"} {
		if strings.Contains(code, bad) {
			t.Errorf("BuildKit-only syntax %q: the file must build on the legacy builder too", bad)
		}
	}
	if !strings.Contains(final, "userdel -r ubuntu") {
		t.Error("Ubuntu 24.04 owns uid 1000 as `ubuntu`; remove it before creating the app user")
	}
	if !strings.Contains(final, "USER 1000:1000") {
		t.Error("the app must run unprivileged")
	}
	if strings.Contains(df, "HEALTHCHECK") && (strings.Contains(df, "python -c") || strings.Contains(df, "node -e")) {
		t.Error("the health check must not start a language runtime")
	}
}

var pinned = regexp.MustCompile(`([a-z0-9][a-z0-9._/-]*:[A-Za-z0-9._-]+)@(sha256:[0-9a-f]{64})`)

func TestEveryImageIsPinnedAndOldEnough(t *testing.T) {
	var cache map[string]struct {
		Created time.Time `json:"created"`
		Checked time.Time `json:"checked"`
	}
	if err := json.Unmarshal([]byte(readFile(t, "image-digests.json")), &cache); err != nil {
		t.Fatal(err)
	}
	df, dc := readFile(t, "Dockerfile"), readFile(t, "docker-compose.yml")
	for _, line := range regexp.MustCompile(`(?m)^ARG IMAGE_[A-Z]+=.*$|^\s+image: .*$`).FindAllString(df+"\n"+dc, -1) {
		line = strings.TrimSpace(line)
		if strings.Contains(line, "IMAGE_REGISTRY=") || strings.Contains(line, "roadmap-studio:local") {
			continue // the prefix itself; the locally built image is never pulled
		}
		m := pinned.FindStringSubmatch(line)
		if m == nil {
			t.Errorf("image without a digest pin: %s", line)
			continue
		}
		if strings.HasPrefix(line, "image:") && !strings.Contains(line, "${IMAGE_REGISTRY-}") {
			t.Errorf("image not pulled through ${IMAGE_REGISTRY-}: %s", line)
		}
		e, ok := cache[m[1]+"@"+m[2]]
		if !ok {
			t.Errorf("%s@%s is not in image-digests.json - run go run ./tools/agegate -refresh", m[1], m[2])
			continue
		}
		if e.Checked.Sub(e.Created) < 72*time.Hour {
			t.Errorf("%s was pinned when it was only %s old; the rule is 72 hours", m[1], e.Checked.Sub(e.Created))
		}
	}
}

func TestComposeKeepsLocationsOverridable(t *testing.T) {
	dc := readFile(t, "docker-compose.yml")
	for _, k := range locationKeys {
		if strings.Contains(dc, "${"+k+":-") {
			t.Errorf("${%s:-...} replaces an EMPTY value with the default - an env file empties it on purpose; use ${%s-...}", k, k)
		}
		if !strings.Contains(dc, k+": ${"+k+"-") {
			t.Errorf("build args must pass %s through", k)
		}
	}
	for _, k := range []string{"IMAGE_REGISTRY", "HTTP_PROXY", "HTTPS_PROXY"} {
		if !strings.Contains(dc, k+": ${"+k+"-}") {
			t.Errorf("%s must default to empty in the compose file (no site baked in)", k)
		}
	}
	if !strings.Contains(dc, "pull_policy: build") || strings.Count(dc, "pull_policy: never") < 2 {
		t.Error("the app builds its image once (pull_policy: build); the init steps reuse it with pull_policy: never")
	}
	if !strings.Contains(dc, "./pgdata:/var/lib/postgresql/data") {
		t.Error("the database must be a bind mount")
	}
	if strings.Contains(dc, "POSTGRES_PASSWORD:") || strings.Contains(dc, "RMS_DB_PASSWORD:") {
		t.Error("passwords are files, never values in the compose file")
	}
}

func TestEnvFilesMatchAndHoldNoSecrets(t *testing.T) {
	deploy, lab := envFile(t, "deploy.env"), envFile(t, "lab.env")
	for k := range deploy {
		if _, ok := lab[k]; !ok {
			t.Errorf("%s is in deploy.env but not lab.env", k)
		}
	}
	for k := range lab {
		if _, ok := deploy[k]; !ok {
			t.Errorf("%s is in lab.env but not deploy.env", k)
		}
	}
	for _, k := range locationKeys {
		if _, ok := deploy[k]; !ok {
			t.Errorf("deploy.env must carry %s, even empty, so a site sees where to put its own location", k)
		}
	}
	for _, k := range []string{"IMAGE_REGISTRY", "HTTP_PROXY", "HTTPS_PROXY"} {
		if deploy[k] != "" {
			t.Errorf("deploy.env %s=%q: the template names no site; leave it empty", k, deploy[k])
		}
	}
	secret := regexp.MustCompile(`(TOKEN|PASSWORD|SECRET|_KEY)$`)
	for name, f := range map[string]map[string]string{"deploy.env": deploy, "lab.env": lab} {
		for k, v := range f {
			if secret.MatchString(k) && v != "" {
				t.Errorf("%s holds a value for %s - secrets never go in a committed env file", name, k)
			}
		}
	}
	if deploy["RMS_DEV_LOGIN_ACKNOWLEDGE"] != "" || deploy["RMS_AUTH_MODE"] != "saml" {
		t.Error("deploy.env must use SAML sign-in and never the test login")
	}
}

func TestGitignoreIsAnchoredAndKeepsEnvFiles(t *testing.T) {
	gi := readFile(t, ".gitignore")
	for _, want := range []string{"/pgdata/", "/credentials/", "/certs/"} {
		if !strings.Contains(gi, want+"\n") {
			t.Errorf(".gitignore must ignore %s (anchored)", want)
		}
	}
	for _, l := range strings.Split(gi, "\n") {
		l = strings.TrimSpace(l)
		if l == "deploy.env" || l == "lab.env" || l == "*.env" {
			t.Errorf(".gitignore ignores %s - the env files are committed", l)
		}
		if l == "certs/" || l == "credentials/" || l == "pgdata/" {
			t.Errorf("unanchored %s would also hide any source folder of that name", l)
		}
	}
}
