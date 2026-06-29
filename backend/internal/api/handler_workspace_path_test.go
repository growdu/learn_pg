package api

import (
	"os"
	"path/filepath"
	"testing"

	"pg-visualizer-backend/internal/config"
	"pg-visualizer-backend/internal/connection"
	"pg-visualizer-backend/internal/ws"
)

// TestNewHandler_UsesConfiguredWorkspaceFilePath locks in the
// config-driven workspace path. Without this guarantee, any deployment
// that starts the server from a different directory (Docker with a
// custom WORKDIR, systemd with WorkingDirectory=, a dev shell that
// 'go run's from the repo root) would silently get a fresh empty
// workspace and lose every previously registered node.
func TestNewHandler_UsesConfiguredWorkspaceFilePath(t *testing.T) {
	dir := t.TempDir()
	wsPath := filepath.Join(dir, "ws.json")
	taskPath := filepath.Join(dir, "tasks.json")

	cfg := &config.Config{
		WorkspaceFilePath:     wsPath,
		ProvisionTaskFilePath: taskPath,
	}

	hub := ws.NewHub(nil)
	go hub.Run()
	defer hub.Stop()
	mgr := connection.NewManager(cfg)

	h := NewHandler(cfg, hub, mgr)
	if h == nil {
		t.Fatal("NewHandler returned nil")
	}
	if h.workspace == nil {
		t.Fatal("workspace store not initialized")
	}
	if got := h.workspace.path; got != wsPath {
		t.Errorf("workspace path = %q, want %q", got, wsPath)
	}
	if got := h.taskPath; got != taskPath {
		t.Errorf("task path = %q, want %q", got, taskPath)
	}
}

// TestNewHandler_CWDDoesNotInfluencePath makes the requirement
// explicit: even when CWD is "/", the handler must use the
// configured path and never silently fall back to a CWD-relative
// default.
func TestNewHandler_CWDDoesNotInfluencePath(t *testing.T) {
	dir := t.TempDir()
	wsPath := filepath.Join(dir, "ws.json")
	cfg := &config.Config{
		WorkspaceFilePath:     wsPath,
		ProvisionTaskFilePath: filepath.Join(dir, "tasks.json"),
	}

	// Save and restore CWD.
	orig, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	t.Cleanup(func() { _ = os.Chdir(orig) })

	// Chdir to a directory the configured path does NOT depend on.
	if err := os.Chdir(os.TempDir()); err != nil {
		t.Fatalf("chdir: %v", err)
	}

	hub := ws.NewHub(nil)
	go hub.Run()
	defer hub.Stop()
	mgr := connection.NewManager(cfg)
	h := NewHandler(cfg, hub, mgr)
	if h.workspace.path != wsPath {
		t.Errorf("CWD leaked into workspace path: got %q want %q",
			h.workspace.path, wsPath)
	}
}
