package main

import (
	"strings"
	"testing"
	"time"
)

func TestPasswordHash(t *testing.T) {
	h, err := hashPassword("admin")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(h, "admin") || !strings.HasPrefix(h, "pbkdf2-sha256$600000$") {
		t.Fatalf("unexpected stored form %q", h)
	}
	if !verifyPassword("admin", h) {
		t.Error("the right password was refused")
	}
	for _, wrong := range []string{"", "Admin", "admin ", "admin2"} {
		if verifyPassword(wrong, h) {
			t.Errorf("%q was accepted", wrong)
		}
	}
	h2, _ := hashPassword("admin")
	if h == h2 {
		t.Error("two hashes of the same password are identical - the salt is not random")
	}
	for _, bad := range []string{"", "admin", "pbkdf2-sha256$x$a$b", "pbkdf2-sha256$600000$!!$!!", "md5$1$a$b", decoyHash()} {
		if verifyPassword("admin", bad) {
			t.Errorf("stored value %q accepted", bad)
		}
	}
}

func TestFailureLimits(t *testing.T) {
	var f failures
	for i := 0; i < failPerAddr; i++ {
		if f.blocked("10.0.0.1") > 0 {
			t.Fatalf("blocked after %d failures", i)
		}
		f.add("10.0.0.1")
	}
	if f.blocked("10.0.0.1") == 0 {
		t.Error("not blocked after the per-address limit")
	}
	if f.blocked("10.0.0.2") > 0 {
		t.Error("another address was blocked by the first one's failures")
	}
	for i := 0; i < failOverall; i++ {
		f.add("10.0.1." + string(rune('a'+i%26)))
	}
	if f.blocked("10.0.0.3") == 0 {
		t.Error("not blocked after the overall limit")
	}
	// Old failures stop counting.
	old := time.Now().Add(-failWindow - time.Second)
	f.mu.Lock()
	for k, v := range f.byAddr {
		for i := range v {
			v[i] = old
		}
		f.byAddr[k] = v
	}
	for i := range f.all {
		f.all[i] = old
	}
	f.mu.Unlock()
	if f.blocked("10.0.0.1") > 0 {
		t.Error("still blocked after the window passed")
	}
}

func TestSafeReturnRefusesAPI(t *testing.T) {
	if got := safeReturn("/api/me"); got != "/" {
		t.Errorf("safeReturn(/api/me) = %q", got)
	}
}
