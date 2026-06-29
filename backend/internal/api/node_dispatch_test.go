package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pg-visualizer-backend/internal/config"
	"pg-visualizer-backend/internal/connection"
)

// newNodeRouteHandler builds a Handler with a real workspaceStore in a
// temp dir seeded with one project/cluster/node so dispatcher tests can
// exercise the GET / PUT / DELETE / status / activate paths end-to-end
// without standing up the full mux. The status route needs a real
// connMgr (Health panics on nil), so we wire one up.
func newNodeRouteHandler(t *testing.T) *Handler {
	t.Helper()
	tmp := t.TempDir()
	store := newWorkspaceStore(filepath.Join(tmp, "ws.json"), nil)
	seed := `{
  "schemaVersion": 2,
  "projects": [{
    "id": "p1", "name": "p",
    "clusters": [{
      "id": "c1", "name": "c",
      "replicationType": "physical",
      "alertThresholdSec": 30,
      "nodes": [{
        "id": "n1", "name": "Node 1",
        "host": "127.0.0.1", "port": 5432,
        "user": "postgres", "password": "postgres",
        "database": "postgres",
        "cluster_type": "physical", "role": "primary",
        "source": "manual",
        "connectionStatus": "ready", "lastError": ""
      }]
    }],
    "components": []
  }],
  "hosts": null
}`
	if err := os.WriteFile(store.path, []byte(seed), 0644); err != nil {
		t.Fatalf("seed workspace: %v", err)
	}
	return &Handler{
		workspace: store,
		connMgr:   connection.NewManager(&config.Config{}),
	}
}

func callNodeRoute(h *Handler, method, path string, body string) *httptest.ResponseRecorder {
	var r *http.Request
	if body != "" {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	} else {
		r = httptest.NewRequest(method, path, nil)
	}
	rr := httptest.NewRecorder()
	h.ServeNodeRoute(rr, r)
	return rr
}

// --- Dispatcher matrix ----------------------------------------------------

// The whole point of the refactor: PUT and DELETE used to be 405'd by the
// dispatcher itself, before ServeNodeByID ever got a chance to validate.
// After the fix they reach ServeNodeByID, which then enforces the method.
func TestServeNodeRoute_PUTReachesHandler(t *testing.T) {
	h := newNodeRouteHandler(t)
	rr := callNodeRoute(h, http.MethodPut, "/api/nodes/n1",
		`{"host":"10.0.0.1","port":5433}`)
	if rr.Code == http.StatusMethodNotAllowed {
		t.Fatalf("PUT blocked by dispatcher: %d %s", rr.Code, rr.Body.String())
	}
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}
	// Confirm the update actually persisted.
	rr2 := callNodeRoute(h, http.MethodGet, "/api/nodes/n1", "")
	var resp struct {
		Success bool             `json:"success"`
		Node    *workspaceNode    `json:"node"`
	}
	if err := json.NewDecoder(rr2.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Node == nil || resp.Node.Host != "10.0.0.1" || resp.Node.Port != 5433 {
		t.Fatalf("update did not persist: %+v", resp.Node)
	}
}

func TestServeNodeRoute_DELETEReachesHandler(t *testing.T) {
	h := newNodeRouteHandler(t)
	rr := callNodeRoute(h, http.MethodDelete, "/api/nodes/n1", "")
	if rr.Code == http.StatusMethodNotAllowed {
		t.Fatalf("DELETE blocked by dispatcher: %d %s", rr.Code, rr.Body.String())
	}
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}
	// And the node is actually gone.
	rr2 := callNodeRoute(h, http.MethodGet, "/api/nodes/n1", "")
	if rr2.Code != http.StatusNotFound {
		t.Fatalf("expected 404 after delete, got %d", rr2.Code)
	}
}

func TestServeNodeRoute_GETStatus(t *testing.T) {
	h := newNodeRouteHandler(t)
	rr := callNodeRoute(h, http.MethodGet, "/api/nodes/n1/status", "")
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), `"connectionStatus"`) {
		t.Fatalf("body missing connectionStatus: %s", rr.Body.String())
	}
}

func TestServeNodeRoute_GETByID(t *testing.T) {
	h := newNodeRouteHandler(t)
	rr := callNodeRoute(h, http.MethodGet, "/api/nodes/n1", "")
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}
}

func TestServeNodeRoute_POSTUnknownActionIs404(t *testing.T) {
	h := newNodeRouteHandler(t)
	rr := callNodeRoute(h, http.MethodPost, "/api/nodes/n1/bogus", "")
	if rr.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body=%s", rr.Code, rr.Body.String())
	}
}

func TestServeNodeRoute_PATCHIs405(t *testing.T) {
	h := newNodeRouteHandler(t)
	rr := callNodeRoute(h, http.MethodPatch, "/api/nodes/n1",
		`{"host":"x"}`)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405; body=%s", rr.Code, rr.Body.String())
	}
}
