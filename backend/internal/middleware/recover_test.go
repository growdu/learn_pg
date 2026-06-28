package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"pg-visualizer-backend/internal/reporter"
)

func TestRecoverCatchesPanic(t *testing.T) {
	rep := reporter.New(reporter.Config{}) // no-op
	h := Recover(rep)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("boom")
	}))

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/x", nil))

	if rr.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), "internal server error") {
		t.Errorf("body = %q, want error JSON", rr.Body.String())
	}
}

func TestRecoverNoPanicPassesThrough(t *testing.T) {
	rep := reporter.New(reporter.Config{})
	h := Recover(rep)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
		w.Write([]byte("ok"))
	}))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/x", nil))
	if rr.Code != http.StatusTeapot {
		t.Errorf("status = %d, want 418", rr.Code)
	}
	if rr.Body.String() != "ok" {
		t.Errorf("body = %q, want ok", rr.Body.String())
	}
}

func TestRecoverNilReporter(t *testing.T) {
	// Should still recover the panic, just without reporting it.
	h := Recover(nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("boom")
	}))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/x", nil))
	if rr.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500", rr.Code)
	}
}
