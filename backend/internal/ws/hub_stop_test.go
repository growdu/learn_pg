package ws

import (
	"testing"
	"time"
)

func TestHubStopExitsRun(t *testing.T) {
	h := NewHub(nil)
	done := make(chan struct{})
	go func() {
		h.Run()
		close(done)
	}()
	// Give Run a moment to start its select.
	time.Sleep(10 * time.Millisecond)
	h.Stop()
	select {
	case <-done:
		// ok
	case <-time.After(time.Second):
		t.Fatal("Hub.Run did not exit within 1s of Stop()")
	}
}

func TestHubStopIsIdempotent(t *testing.T) {
	h := NewHub(nil)
	go h.Run()
	time.Sleep(10 * time.Millisecond)
	h.Stop()
	// Second call must not panic (stopOnce guards close(stop)).
	done := make(chan struct{})
	go func() { h.Stop(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("second Stop() did not return")
	}
}
