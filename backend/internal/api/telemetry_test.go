package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The telemetry endpoints are minimal fire-and-forget sinks: they
// validate the JSON envelope, log each report/sample, and return
// 202 with {"accepted":true}. They don't enforce per-batch count
// caps — the frontend already caps at the source. They do enforce
// a total body size cap (1 MiB errors, 256 KiB vitals) so a
// runaway client can't OOM the backend.

func newTelemetryHandler() *Handler {
	return &Handler{}
}

func doTelemetry(t *testing.T, h *Handler, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		reader = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	rr := httptest.NewRecorder()
	switch path {
	case "/api/telemetry/errors":
		h.ServeTelemetryErrors(rr, req)
	case "/api/telemetry/vitals":
		h.ServeTelemetryVitals(rr, req)
	default:
		t.Fatalf("unknown path %s", path)
	}
	return rr
}

func TestServeTelemetryErrors_AcceptsBatch(t *testing.T) {
	h := newTelemetryHandler()
	body := map[string]any{
		"reports": []map[string]any{
			{
				"message": "boom",
				"stack":   "Error: boom\n  at foo (foo.ts:1:1)",
				"source":  "uncaught",
				"url":     "http://localhost/",
			},
		},
	}
	rr := doTelemetry(t, h, http.MethodPost, "/api/telemetry/errors", body)
	if rr.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202; body=%s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), `"accepted":true`) {
		t.Fatalf("missing accepted in body: %s", rr.Body.String())
	}
}

func TestServeTelemetryErrors_RejectsBadJSON(t *testing.T) {
	h := newTelemetryHandler()
	req := httptest.NewRequest(http.MethodPost, "/api/telemetry/errors",
		strings.NewReader("not-json"))
	rr := httptest.NewRecorder()
	h.ServeTelemetryErrors(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rr.Code)
	}
}

func TestServeTelemetryErrors_RejectsOversizedPayload(t *testing.T) {
	h := newTelemetryHandler()
	// 1.5 MiB > 1 MiB handler cap
	huge := strings.Repeat("x", 1500*1024)
	req := httptest.NewRequest(http.MethodPost, "/api/telemetry/errors",
		strings.NewReader(huge))
	rr := httptest.NewRecorder()
	h.ServeTelemetryErrors(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (handler reads up to 1MiB then errors)", rr.Code)
	}
}

func TestServeTelemetryErrors_AllowsEmptyBatch(t *testing.T) {
	h := newTelemetryHandler()
	rr := doTelemetry(t, h, http.MethodPost, "/api/telemetry/errors",
		map[string]any{"reports": []any{}})
	if rr.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202", rr.Code)
	}
}

func TestServeTelemetryErrors_AllowsMissingReports(t *testing.T) {
	h := newTelemetryHandler()
	rr := doTelemetry(t, h, http.MethodPost, "/api/telemetry/errors", map[string]any{})
	if rr.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202", rr.Code)
	}
}

func TestServeTelemetryErrors_RejectsWrongMethod(t *testing.T) {
	h := newTelemetryHandler()
	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		req := httptest.NewRequest(method, "/api/telemetry/errors", nil)
		rr := httptest.NewRecorder()
		h.ServeTelemetryErrors(rr, req)
		if rr.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s: status = %d, want 405", method, rr.Code)
		}
	}
}

func TestServeTelemetryVitals_AcceptsSamples(t *testing.T) {
	h := newTelemetryHandler()
	body := map[string]any{
		"samples": []map[string]any{
			{"name": "LCP", "value": 1234.5, "rating": "good"},
			{"name": "CLS", "value": 0.05, "rating": "good"},
		},
	}
	rr := doTelemetry(t, h, http.MethodPost, "/api/telemetry/vitals", body)
	if rr.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202; body=%s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), `"accepted":true`) {
		t.Fatalf("missing accepted in body: %s", rr.Body.String())
	}
}

func TestServeTelemetryVitals_RejectsBadJSON(t *testing.T) {
	h := newTelemetryHandler()
	req := httptest.NewRequest(http.MethodPost, "/api/telemetry/vitals",
		strings.NewReader("not-json"))
	rr := httptest.NewRecorder()
	h.ServeTelemetryVitals(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rr.Code)
	}
}

func TestServeTelemetryVitals_RejectsOversizedPayload(t *testing.T) {
	h := newTelemetryHandler()
	// 400 KiB > 256 KiB handler cap
	huge := strings.Repeat("y", 400*1024)
	req := httptest.NewRequest(http.MethodPost, "/api/telemetry/vitals",
		strings.NewReader(huge))
	rr := httptest.NewRecorder()
	h.ServeTelemetryVitals(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rr.Code)
	}
}

func TestServeTelemetryVitals_AllowsEmptySamples(t *testing.T) {
	h := newTelemetryHandler()
	rr := doTelemetry(t, h, http.MethodPost, "/api/telemetry/vitals",
		map[string]any{"samples": []any{}})
	if rr.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202", rr.Code)
	}
}

func TestServeTelemetryVitals_RejectsWrongMethod(t *testing.T) {
	h := newTelemetryHandler()
	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		req := httptest.NewRequest(method, "/api/telemetry/vitals", nil)
		rr := httptest.NewRecorder()
		h.ServeTelemetryVitals(rr, req)
		if rr.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s: status = %d, want 405", method, rr.Code)
		}
	}
}
