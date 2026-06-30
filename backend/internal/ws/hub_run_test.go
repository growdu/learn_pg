package ws

import (
	"encoding/json"
	"testing"
	"time"
)

// TestHubBroadcastJSONError covers the path where json.Marshal fails.
// The hub must swallow the marshal error (it logs and returns) instead
// of panicking or blocking. We don't have a capture for log output here,
// so we just assert that the broadcast channel does NOT receive an
// outbound frame and that the call returns promptly.
func TestHubBroadcastJSONError(t *testing.T) {
	h := NewHub(nil)
	go h.Run()
	defer h.Stop()

	// json.Marshal cannot encode channels or funcs.
	h.Broadcast(make(chan int))
	h.Broadcast(func() {})

	select {
	case msg := <-h.broadcast:
		t.Fatalf("hub should not have forwarded an unmarshalable message, got %x", msg)
	case <-time.After(50 * time.Millisecond):
		// good — nothing on the channel
	}
}

// TestHubRunBroadcastReachesAllClients exercises the happy path of
// Hub.Run: register several clients, broadcast a message, verify each
// client's send buffer receives the payload. We construct clients
// manually (bypassing ServeWs) so we don't need a real WS handshake.
func TestHubRunBroadcastReachesAllClients(t *testing.T) {
	h := NewHub(nil)
	go h.Run()
	defer h.Stop()

	const n = 3
	clients := make([]*Client, n)
	for i := 0; i < n; i++ {
		c := &Client{
			hub:  h,
			send: make(chan []byte, 4),
		}
		clients[i] = c
		h.register <- c
	}

	// Give Run a moment to drain the register queue.
	waitFor(t, func() bool { return h.ClientCount() == n }, time.Second)
	if got := h.ClientCount(); got != n {
		t.Fatalf("after register: ClientCount=%d, want %d", got, n)
	}

	want := map[string]any{"kind": "fanout"}
	h.Broadcast(want)

	// Each client should see exactly one message with matching payload.
	for i, c := range clients {
		select {
		case msg := <-c.send:
			var got map[string]any
			if err := json.Unmarshal(msg, &got); err != nil {
				t.Fatalf("client %d: unmarshal: %v", i, err)
			}
			if got["kind"] != "fanout" {
				t.Errorf("client %d: kind=%v, want fanout", i, got["kind"])
			}
		case <-time.After(time.Second):
			t.Fatalf("client %d: no broadcast received within 1s", i)
		}
	}
}

// TestHubRunUnregisterRemovesClient verifies that sending on the
// unregister channel removes the client from the hub.
func TestHubRunUnregisterRemovesClient(t *testing.T) {
	h := NewHub(nil)
	go h.Run()
	defer h.Stop()

	c := &Client{hub: h, send: make(chan []byte, 1)}
	h.register <- c
	waitFor(t, func() bool { return h.ClientCount() == 1 }, time.Second)

	h.unregister <- c
	waitFor(t, func() bool { return h.ClientCount() == 0 }, time.Second)
}

// TestHubRunDropsSlowClient exercises the slow-client branch in Run:
// when a client's send buffer is full, Run closes the channel and
// removes it from the registry instead of blocking.
func TestHubRunDropsSlowClient(t *testing.T) {
	h := NewHub(nil)
	go h.Run()
	defer h.Stop()

	// Buffer size 1 — second send will fill it, third will hit the
	// "default: drop" branch in Run.
	slow := &Client{hub: h, send: make(chan []byte, 1)}
	h.register <- slow
	waitFor(t, func() bool { return h.ClientCount() == 1 }, time.Second)

	// Fill the buffer with one broadcast.
	h.Broadcast(map[string]int{"n": 1})
	select {
	case <-slow.send:
	case <-time.After(time.Second):
		t.Fatal("first broadcast never arrived")
	}

	// Now overflow: send a broadcast that cannot be delivered.
	h.Broadcast(map[string]int{"n": 2})
	h.Broadcast(map[string]int{"n": 3})

	// Slow client must be evicted within a short window.
	waitFor(t, func() bool { return h.ClientCount() == 0 }, time.Second)
}

// TestHubStopClosesAllClients verifies that when Stop is called, every
// remaining client's send channel is closed (so the write pump can
// unblock and exit instead of leaking).
func TestHubStopClosesAllClients(t *testing.T) {
	h := NewHub(nil)
	go h.Run()

	a := &Client{hub: h, send: make(chan []byte, 1)}
	b := &Client{hub: h, send: make(chan []byte, 1)}
	h.register <- a
	h.register <- b
	waitFor(t, func() bool { return h.ClientCount() == 2 }, time.Second)

	h.Stop()

	for i, c := range []*Client{a, b} {
		select {
		case _, ok := <-c.send:
			if ok {
				t.Errorf("client %d: send channel should be closed by Stop", i)
			}
		case <-time.After(time.Second):
			t.Errorf("client %d: send channel not closed within 1s of Stop", i)
		}
	}
}

// waitFor polls cond up to timeout, sleeping 5ms between checks. Test
// fails if cond never returns true.
func waitFor(t *testing.T, cond func() bool, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("waitFor timed out after %v", timeout)
}