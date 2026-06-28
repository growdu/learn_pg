package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"pg-visualizer-backend/internal/config"
	"pg-visualizer-backend/internal/connection"
	"pg-visualizer-backend/internal/ws"
)

// newReadyzHandler builds a minimal Handler wired just enough for /readyz.
// We don't need a real connection manager or provision service to exercise
// the readiness logic; nil is fine because ServeReadyz only touches them
// when the WS check is configured.
func newReadyzHandler(t *testing.T) *Handler {
	t.Helper()
	tmp := t.TempDir()
	store := newWorkspaceStore(filepath.Join(tmp, "ws.json"), nil)
	// Write a valid workspace file so the parse probe succeeds.
	if err := os.WriteFile(store.path, []byte(`{"projects":[],"schemaVersion":2}`), 0644); err != nil {
		t.Fatal(err)
	}
	return &Handler{
		config:    &config.Config{CollectorWSURL: ""}, // skip WS probe
		hub:       ws.NewHub(),
		connMgr:   connection.NewManager(&config.Config{}),
		workspace: store,
	}
}

func TestServeReadyz_ReadyWhenDataDirWritableAndWorkspaceParses(t *testing.T) {
	h := newReadyzHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	rr := httptest.NewRecorder()
	h.ServeReadyz(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rr.Code, rr.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["status"] != "ready" {
		t.Fatalf("status = %q, want ready", body["status"])
	}
	if body["workspace"] != "ok" {
		t.Fatalf("workspace = %q, want ok", body["workspace"])
	}
}

func TestServeReadyz_NotReadyWhenDataDirMissing(t *testing.T) {
	h := newReadyzHandler(t)
	// Override workspace path to a directory under a non-existent root.
	h.workspace.path = filepath.Join(t.TempDir(), "nonexistent-subdir", "ws.json")
	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	rr := httptest.NewRecorder()
	h.ServeReadyz(rr, req)

	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rr.Code)
	}
	var body map[string]string
	_ = json.Unmarshal(rr.Body.Bytes(), &body)
	if body["status"] != "not_ready" {
		t.Fatalf("status = %q, want not_ready", body["status"])
	}
}

func TestServeReadyz_NotReadyWhenWorkspaceCorrupted(t *testing.T) {
	h := newReadyzHandler(t)
	// Overwrite with garbage so the parse probe fails.
	if err := os.WriteFile(h.workspace.path, []byte("not json {{{"), 0644); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/readyz", nil)
	rr := httptest.NewRecorder()
	h.ServeReadyz(rr, req)

	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rr.Code)
	}
}