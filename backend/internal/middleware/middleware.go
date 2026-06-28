package middleware

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// requestIDKey is the context key for the request ID.
type requestIDKey struct{}

// requestIDFromContext retrieves the request ID from context.
func RequestIDFromContext(ctx context.Context) string {
	if id, ok := ctx.Value(requestIDKey{}).(string); ok {
		return id
	}
	return ""
}

// generateID creates a random 16-byte ID as a hex string (32 chars).
func generateID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// RequestID middleware injects a unique X-Request-ID header into every request.
// The ID is stored in the request context so handlers can retrieve it.
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-ID")
		if id == "" {
			id = generateID()
		}
		w.Header().Set("X-Request-ID", id)

		// r.WithContext returns a new Request — must reassign r so
		// downstream middleware/handlers see the updated context.
		ctx := context.WithValue(r.Context(), requestIDKey{}, id)
		r = r.WithContext(ctx)
		next.ServeHTTP(w, r)
	})
}

// Logger middleware logs every request with method, path, status, and duration.
// It reads the request ID from context (set by RequestID middleware).
func Logger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Skip WebSocket upgrade requests
		if r.URL.Path == "/ws" {
			next.ServeHTTP(w, r)
			return
		}

		reqID := r.Header.Get("X-Request-Id")
		wrap := &statusWriter{ResponseWriter: w, statusCode: http.StatusOK}
		start := time.Now()

		next.ServeHTTP(w, r)

		duration := time.Since(start)
		slog.Info("http request",
			slog.String("request_id", reqID),
			slog.String("method", r.Method),
			slog.String("path", r.URL.Path),
			slog.Int("status", wrap.statusCode),
			slog.Duration("duration", duration),
		)
	})
}

// CORSConfig configures the CORS middleware. AllowedOrigins is a
// whitelist; "*" alone means "any origin, no credentials" which is
// the previous (insecure-by-default) behaviour. When "*" is in the
// list together with any other origin, the safer origin-echo
// behaviour kicks in.
type CORSConfig struct {
	// AllowedOrigins is the whitelist of origins the server will echo
	// back in Access-Control-Allow-Origin. Empty -> no CORS headers
	// at all (same-origin only). "*" alone -> "*".
	AllowedOrigins []string
	// AllowedMethods is the set of methods allowed in preflight.
	AllowedMethods []string
	// AllowedHeaders is the set of request headers allowed in
	// preflight. Defaults to Content-Type, X-Request-ID,
	// X-API-Key (the auth token header used by the rest of the
	// backend).
	AllowedHeaders []string
	// AllowCredentials toggles Access-Control-Allow-Credentials.
	// When true, the wildcard origin is not allowed; you must list
	// specific origins.
	AllowCredentials bool
}

// DefaultCORSConfig returns the defaults used when main.go doesn't
// override anything. "*" preserves the previous behaviour; deployers
// who care about CORS should set CORS_ALLOWED_ORIGINS in their env.
func DefaultCORSConfig() CORSConfig {
	return CORSConfig{
		AllowedOrigins: []string{"*"},
		AllowedMethods: []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders: []string{"Content-Type", "X-Request-ID", "X-API-Key"},
	}
}

// CORS applies the configured policy. On preflight (OPTIONS) requests
// it short-circuits with 204 + the relevant headers. On actual
// requests it only echoes Access-Control-Allow-Origin when the
// request's Origin header is in the allowlist.
func CORS(cfg CORSConfig) func(http.Handler) http.Handler {
	if len(cfg.AllowedMethods) == 0 {
		cfg.AllowedMethods = []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"}
	}
	if len(cfg.AllowedHeaders) == 0 {
		cfg.AllowedHeaders = []string{"Content-Type", "X-Request-ID", "X-API-Key"}
	}
	// Build a set for O(1) origin lookup.
	allowed := make(map[string]struct{}, len(cfg.AllowedOrigins))
	wildcard := false
	for _, o := range cfg.AllowedOrigins {
		if o == "*" {
			wildcard = true
		}
		allowed[o] = struct{}{}
	}
	if cfg.AllowCredentials && wildcard {
		// Browser spec forbids credentials + wildcard origin.
		wildcard = false
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			switch {
			case wildcard:
				w.Header().Set("Access-Control-Allow-Origin", "*")
			case origin != "":
				if _, ok := allowed[origin]; ok {
					w.Header().Set("Access-Control-Allow-Origin", origin)
					w.Header().Add("Vary", "Origin")
				}
			}
			w.Header().Set("Access-Control-Allow-Methods", strings.Join(cfg.AllowedMethods, ", "))
			w.Header().Set("Access-Control-Allow-Headers", strings.Join(cfg.AllowedHeaders, ", "))
			if cfg.AllowCredentials {
				w.Header().Set("Access-Control-Allow-Credentials", "true")
			}
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// CORSWithDefaults is a convenience for tests and callers that don't
// care about the config; it produces the same wildcard behaviour the
// project shipped before this change.
func CORSWithDefaults(next http.Handler) http.Handler {
	return CORS(DefaultCORSConfig())(next)
}

// statusWriter captures the status code written by the handler.
type statusWriter struct {
	http.ResponseWriter
	statusCode int
}

func (sw *statusWriter) WriteHeader(code int) {
	sw.statusCode = code
	sw.ResponseWriter.WriteHeader(code)
}
