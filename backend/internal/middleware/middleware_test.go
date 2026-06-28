package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRequestIDGeneratesNew(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/test", func(w http.ResponseWriter, r *http.Request) {
		// Header is set on response, not request
		w.WriteHeader(http.StatusOK)
	})

	handler := RequestID(mux)
	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
	got := rec.Header().Get("X-Request-Id")
	if got == "" {
		t.Error("X-Request-Id response header should be set")
	}
	if len(got) != 32 {
		t.Errorf("X-Request-Id length = %d, want 32 (hex of 16 bytes)", len(got))
	}
}

func TestRequestIDPreservesIncoming(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/test", func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get("X-Request-ID")
		if got != "my-fixed-id" {
			t.Errorf("X-Request-ID = %q, want my-fixed-id", got)
		}
		w.WriteHeader(http.StatusOK)
	})

	handler := RequestID(mux)
	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("X-Request-ID", "my-fixed-id")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
}

func TestRequestIDUnique(t *testing.T) {
	handler := RequestID(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	ids := make(map[string]bool)
	for i := 0; i < 100; i++ {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		id := rec.Header().Get("X-Request-ID")
		if id == "" {
			t.Fatal("X-Request-ID not set")
		}
		if ids[id] {
			t.Errorf("duplicate ID generated: %s", id)
		}
		ids[id] = true
	}
}

func TestLoggerSkipsWS(t *testing.T) {
	var called bool
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusSwitchingProtocols)
	})

	handler := Logger(mux)
	req := httptest.NewRequest(http.MethodGet, "/ws", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if !called {
		t.Error("WS handler should be called")
	}
}

func TestCORSOptions(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/test", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	handler := CORSWithDefaults(mux)
	req := httptest.NewRequest(http.MethodOptions, "/test", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("OPTIONS status = %d, want 204", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("CORS Allow-Origin = %q, want *", got)
	}
}

func TestCORSAllowsMethod(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/test", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	handler := CORSWithDefaults(mux)
	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Methods"); !strings.Contains(got, "GET") {
		t.Errorf("CORS Allow-Methods should contain GET, got %q", got)
	}
}

func TestStatusWriterCapturesCode(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/test", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
	})

	handler := Logger(mux)
	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Errorf("response status = %d, want 201", rec.Code)
	}
}


func TestCORSWhitelistEchoesOrigin(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/x", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	h := CORS(CORSConfig{AllowedOrigins: []string{"https://app.example.com"}})(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("Origin", "https://app.example.com")
	h.ServeHTTP(rec, req)
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://app.example.com" {
		t.Errorf("Allow-Origin = %q, want echoed origin", got)
	}
	if got := rec.Header().Get("Vary"); got != "Origin" {
		t.Errorf("Vary = %q, want Origin", got)
	}
}

func TestCORSWhitelistRejectsUnknownOrigin(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/x", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	h := CORS(CORSConfig{AllowedOrigins: []string{"https://app.example.com"}})(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("Origin", "https://attacker.example.com")
	h.ServeHTTP(rec, req)
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("Allow-Origin should be empty for unknown origin, got %q", got)
	}
}

func TestCORSCredentialsDisablesWildcard(t *testing.T) {
	// Browser spec: credentials + wildcard origin is forbidden, so
	// when both are requested we must NOT echo "*" - we must echo
	// the specific origin or nothing. The implementation here is
	// to treat the request as a miss when wildcard is dropped, so
	// unknown origins get no Allow-Origin header.
	mux := http.NewServeMux()
	mux.HandleFunc("/x", func(w http.ResponseWriter, r *http.Request) {})
	h := CORS(CORSConfig{AllowedOrigins: []string{"*"}, AllowCredentials: true})(mux)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("Origin", "https://anywhere.example.com")
	h.ServeHTTP(rec, req)
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("Allow-Origin = %q, want empty (wildcard disabled by credentials)", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Errorf("Allow-Credentials = %q, want true", got)
	}

	// But a specific origin that IS in the allowlist still works.
	rec2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodGet, "/x", nil)
	req2.Header.Set("Origin", "https://app.example.com")
	h2 := CORS(CORSConfig{
		AllowedOrigins:    []string{"https://app.example.com"},
		AllowCredentials: true,
	})(mux)
	h2.ServeHTTP(rec2, req2)
	if got := rec2.Header().Get("Access-Control-Allow-Origin"); got != "https://app.example.com" {
		t.Errorf("Allow-Origin with creds = %q, want specific origin", got)
	}
}
