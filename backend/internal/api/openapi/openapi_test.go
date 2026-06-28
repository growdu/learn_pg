package openapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHandlerServesValidOpenAPI3(t *testing.T) {
	srv := httptest.NewServer(Handler())
	defer srv.Close()

	resp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	ct := resp.Header.Get("Content-Type")
	if ct == "" || ct[:16] != "application/json" {
		t.Errorf("Content-Type = %q, want application/json...", ct)
	}
	if cc := resp.Header.Get("Cache-Control"); cc == "" {
		t.Error("Cache-Control header missing; spec should be cacheable")
	}

	var doc map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got := doc["openapi"]; got != "3.0.3" {
		t.Errorf("openapi = %v, want 3.0.3", got)
	}
	paths, ok := doc["paths"].(map[string]any)
	if !ok {
		t.Fatal("paths missing or wrong type")
	}
	// Spot-check a handful of paths so the spec obviously describes
	// what the backend exposes.
	wantPaths := []string{
		"/health",
		"/readyz",
		"/livez",
		"/version",
		"/metrics",
		"/api/connect",
		"/api/execute",
		"/api/provision/tasks",
		"/api/discovery/dsn/validate",
		"/ws",
	}
	for _, p := range wantPaths {
		if _, ok := paths[p]; !ok {
			t.Errorf("path %q missing from spec", p)
		}
	}
}

func TestHandlerRejectsPOST(t *testing.T) {
	srv := httptest.NewServer(Handler())
	defer srv.Close()

	resp, err := http.Post(srv.URL, "application/json", nil)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", resp.StatusCode)
	}
}

func TestHandlerHEADReturnsHeadersNoBody(t *testing.T) {
	srv := httptest.NewServer(Handler())
	defer srv.Close()

	resp, err := http.Head(srv.URL)
	if err != nil {
		t.Fatalf("HEAD: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("status = %d, want 200", resp.StatusCode)
	}
	if resp.TransferEncoding != nil {
		t.Errorf("Transfer-Encoding = %v; HEAD response should not chunk", resp.TransferEncoding)
	}
}
