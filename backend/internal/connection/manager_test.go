package connection

import (
	"testing"

	"pg-visualizer-backend/internal/config"
)

// newTestManager returns a Manager with no environment dependencies.
// We only need a non-nil *config.Config for NewManager to not panic;
// the manager doesn't read from it during the unit-tested paths.
func newTestManager(t *testing.T) *Manager {
	t.Helper()
	return NewManager(&config.Config{})
}

func TestRegisterAndGetConfig(t *testing.T) {
	m := newTestManager(t)
	cfg := Config{Host: "db.local", Port: 5432, User: "alice", Password: "s3cret", Database: "app"}
	m.Register("node-1", cfg)

	got, ok := m.GetConfig("node-1")
	if !ok {
		t.Fatal("expected config to be present after Register")
	}
	if got != cfg {
		t.Errorf("config mismatch: got %+v want %+v", got, cfg)
	}
}

func TestRegisterOverwritesExisting(t *testing.T) {
	m := newTestManager(t)
	m.Register("node-1", Config{Host: "first", Port: 5432, User: "u", Password: "p", Database: "d"})
	m.Register("node-1", Config{Host: "second", Port: 5432, User: "u", Password: "p", Database: "d"})

	got, _ := m.GetConfig("node-1")
	if got.Host != "second" {
		t.Errorf("expected host 'second' after re-register, got %q", got.Host)
	}
}

func TestGetConfigMissing(t *testing.T) {
	m := newTestManager(t)
	if _, ok := m.GetConfig("ghost"); ok {
		t.Error("expected GetConfig to return ok=false for unregistered node")
	}
}

func TestGetOnUnconnectedNode(t *testing.T) {
	m := newTestManager(t)
	if _, err := m.Get("node-1"); err == nil {
		t.Error("expected error from Get on unconnected node")
	}
}

func TestActivateWithoutRegister(t *testing.T) {
	m := newTestManager(t)
	err := m.Activate("node-1")
	if err == nil {
		t.Fatal("expected Activate to fail when no config is registered")
	}
	// We expect a "config not found" style error rather than a network error.
	if _, ok := m.GetConfig("node-1"); ok {
		t.Error("Activate must not implicitly register a config")
	}
}

func TestGetActiveEmpty(t *testing.T) {
	m := newTestManager(t)
	id, c := m.GetActive()
	if id != "" || c != nil {
		t.Errorf("expected empty active, got id=%q client=%v", id, c)
	}
}

func TestCountEmpty(t *testing.T) {
	m := newTestManager(t)
	if got := m.Count(); got != 0 {
		t.Errorf("expected Count 0, got %d", got)
	}
}

func TestCountIncludesRegisteredButNotConnected(t *testing.T) {
	// Registering a config does NOT create a connection. Count tracks
	// active connections, not configs. This is the contract callers
	// rely on (e.g. metrics scrape).
	m := newTestManager(t)
	m.Register("node-1", Config{Host: "h", Port: 5432, User: "u", Password: "p", Database: "d"})
	m.Register("node-2", Config{Host: "h", Port: 5432, User: "u", Password: "p", Database: "d"})

	if got := m.Count(); got != 0 {
		t.Errorf("expected Count 0 after only Register calls, got %d", got)
	}
}

func TestHealthOnUnconnectedNode(t *testing.T) {
	m := newTestManager(t)
	ok, err := m.Health("node-1")
	if ok {
		t.Error("expected Health to report not-ok for unconnected node")
	}
	if err == nil {
		t.Error("expected Health to return an error for unconnected node")
	}
}

func TestUnregisterRemovesConfig(t *testing.T) {
	m := newTestManager(t)
	m.Register("node-1", Config{Host: "h", Port: 5432, User: "u", Password: "p", Database: "d"})
	if err := m.Unregister("node-1"); err != nil {
		t.Fatalf("Unregister returned error: %v", err)
	}
	if _, ok := m.GetConfig("node-1"); ok {
		t.Error("expected config to be removed after Unregister")
	}
}

func TestUnregisterUnknownNodeIsNoop(t *testing.T) {
	m := newTestManager(t)
	if err := m.Unregister("never-registered"); err != nil {
		t.Errorf("Unregister on unknown node should be a no-op, got error: %v", err)
	}
}

func TestDeactivateUnknownNodeIsNoop(t *testing.T) {
	m := newTestManager(t)
	if err := m.Deactivate("never-registered"); err != nil {
		t.Errorf("Deactivate on unknown node should be a no-op, got error: %v", err)
	}
}

func TestCloseEmptyManager(t *testing.T) {
	m := newTestManager(t)
	// Should not panic when there are no active connections.
	m.Close()
	if got := m.Count(); got != 0 {
		t.Errorf("expected Count 0 after Close, got %d", got)
	}
	if id, _ := m.GetActive(); id != "" {
		t.Errorf("expected active cleared after Close, got %q", id)
	}
}

func TestCloseWithRegisteredButNotConnected(t *testing.T) {
	// Closing with registered-but-not-connected nodes should leave the
	// config map alone (Close is about sockets, not configs) and not
	// crash.
	m := newTestManager(t)
	m.Register("node-1", Config{Host: "h", Port: 5432, User: "u", Password: "p", Database: "d"})
	m.Close()

	if _, ok := m.GetConfig("node-1"); !ok {
		t.Error("Close should not clear registered configs")
	}
}
