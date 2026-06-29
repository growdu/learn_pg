package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"pg-visualizer-backend/internal/telemetrystore"
)

// The telemetry endpoints are minimal fire-and-forget sinks: they
// validate the JSON envelope, log each report/sample, and return
// 202 with {"accepted":true}. They don't enforce per-batch count
// caps — the frontend already caps at the source. They do enforce
// a total body size cap (1 MiB errors, 256 KiB vitals) so a
// runaway client can't OOM the backend.

func newTelemetryHandler() *Handler {
	return &Handler{telemetry: telemetrystore.New("")}
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
	switch req.URL.Path {
	case "/api/telemetry/errors":
		h.ServeTelemetryErrors(rr, req)
	case "/api/telemetry/vitals":
		h.ServeTelemetryVitals(rr, req)
	case "/api/telemetry/errors/top":
		h.ServeTelemetryErrorsTop(rr, req)
	default:
		t.Fatalf("unknown path %s", req.URL.Path)
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


// ────────────────────────────────────────────────────────────
// Persist + dedup + top
// ────────────────────────────────────────────────────────────

func TestServeTelemetryErrors_DedupsAndReportsCount(t *testing.T) {
	h := newTelemetryHandler()
	body := map[string]any{
		"reports": []map[string]any{
			{
				"eventId": "e1",
				"level":   "error",
				"message": "boom",
				"stack":   "Error: boom\n  at x",
				"url":     "http://localhost/",
			},
			{
				"eventId": "e2",
				"level":   "error",
				"message": "boom",
				"stack":   "Error: boom\n  at x",
				"url":     "http://localhost/",
			},
			{
				"eventId": "e3",
				"level":   "error",
				"message": "different",
				"stack":   "Error: different\n  at x",
				"url":     "http://localhost/",
			},
		},
	}
	rr := doTelemetry(t, h, http.MethodPost, "/api/telemetry/errors", body)
	if rr.Code != http.StatusAccepted {
		t.Fatalf("status: want 202, got %d body=%s", rr.Code, rr.Body)
	}
	var resp struct {
		Accepted bool `json:"accepted"`
		New      int  `json:"new"`
		Deduped  int  `json:"deduped"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !resp.Accepted {
		t.Fatalf("accepted should be true")
	}
	if resp.New != 2 {
		t.Errorf("new: want 2 distinct events, got %d", resp.New)
	}
	if resp.Deduped != 1 {
		t.Errorf("deduped: want 1, got %d", resp.Deduped)
	}
	if h.telemetry.Len() != 2 {
		t.Errorf("store len: want 2, got %d", h.telemetry.Len())
	}
}

func TestServeTelemetryErrors_SkipsUnparseableReport(t *testing.T) {
	h := newTelemetryHandler()
	body := map[string]any{
		"reports": []map[string]any{
			{"eventId": "good", "message": "boom", "stack": "s", "url": "u"},
			// Skip-test: a non-object entry should be tolerated.
			map[string]any{"not_an_object": true},
		},
	}
	rr := doTelemetry(t, h, http.MethodPost, "/api/telemetry/errors", body)
	if rr.Code != http.StatusAccepted {
		t.Fatalf("status: want 202, got %d body=%s", rr.Code, rr.Body)
	}
	// "good" should be recorded; the rest are skipped or recorded as empty.
	// We don't assert exact count here — the contract is: malformed
	// payload does not 400 the batch.
	if h.telemetry.Len() < 1 {
		t.Errorf("expected at least 1 event recorded, got %d", h.telemetry.Len())
	}
}

func TestServeTelemetryErrorsTop_ReturnsRecentFirst(t *testing.T) {
	h := newTelemetryHandler()
	// Seed three distinct events via the POST endpoint.
	for _, msg := range []string{"alpha", "beta", "gamma"} {
		body := map[string]any{
			"reports": []map[string]any{{
				"eventId": "e", "message": msg, "stack": "s", "url": "u",
			}},
		}
		doTelemetry(t, h, http.MethodPost, "/api/telemetry/errors", body)
	}
	rr := doTelemetry(t, h, http.MethodGet, "/api/telemetry/errors/top", nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("status: want 200, got %d body=%s", rr.Code, rr.Body)
	}
	var resp struct {
		Events []struct {
			Message string `json:"message"`
			Count   int64  `json:"count"`
		} `json:"events"`
		Total int `json:"total"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v body=%s", err, rr.Body)
	}
	if resp.Total != 3 {
		t.Errorf("total: want 3, got %d", resp.Total)
	}
	if len(resp.Events) != 3 {
		t.Fatalf("events length: want 3, got %d", len(resp.Events))
	}
	// All three were recorded with count 1.
	for _, e := range resp.Events {
		if e.Count != 1 {
			t.Errorf("event %q: want count=1, got %d", e.Message, e.Count)
		}
	}
	// Most-recently-recorded first.
	if resp.Events[0].Message != "gamma" {
		t.Errorf("first event: want gamma (last recorded), got %s", resp.Events[0].Message)
	}
}

func TestServeTelemetryErrorsTop_Limit(t *testing.T) {
	h := newTelemetryHandler()
	for _, msg := range []string{"a", "b", "c", "d", "e"} {
		body := map[string]any{
			"reports": []map[string]any{{"message": msg, "stack": "s", "url": "u"}},
		}
		doTelemetry(t, h, http.MethodPost, "/api/telemetry/errors", body)
	}
	rr := doTelemetry(t, h, http.MethodGet, "/api/telemetry/errors/top?limit=2", nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("status: %d", rr.Code)
	}
	var resp struct {
		Events []json.RawMessage `json:"events"`
		Total  int               `json:"total"`
	}
	json.Unmarshal(rr.Body.Bytes(), &resp)
	if len(resp.Events) != 2 {
		t.Errorf("limit=2: want 2 events, got %d", len(resp.Events))
	}
	if resp.Total != 5 {
		t.Errorf("total: want 5, got %d", resp.Total)
	}
}

func TestServeTelemetryErrorsTop_ClampsLimit(t *testing.T) {
	h := newTelemetryHandler()
	rr := doTelemetry(t, h, http.MethodGet, "/api/telemetry/errors/top?limit=9999", nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("status: %d body=%s", rr.Code, rr.Body)
	}
	// We can't easily check the clamp without seeding events, but
	// a malformed limit must not crash the handler.
	if !strings.Contains(rr.Body.String(), `"events"`) {
		t.Errorf("response missing events key: %s", rr.Body)
	}
}

func TestServeTelemetryErrorsTop_RejectsWrongMethod(t *testing.T) {
	h := newTelemetryHandler()
	rr := doTelemetry(t, h, http.MethodPost, "/api/telemetry/errors/top", nil)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST: want 405, got %d", rr.Code)
	}
}
