package main

import "testing"

// The router panics at start-up on ambiguous patterns; catch that here, not
// in a crash-looping container.
func TestRoutesRegisterWithoutConflict(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("route registration panicked: %v", r)
		}
	}()
	s := &server{cfg: &config{}, stopping: make(chan struct{})}
	if s.routes() == nil {
		t.Fatal("no handler")
	}
}
