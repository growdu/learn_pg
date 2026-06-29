package ws

import (
	"net/http"
	"strings"
)

// buildCheckOrigin returns a gorilla/websocket CheckOrigin function
// that gates browser-initiated WS upgrades against the same allowlist
// the HTTP CORS middleware uses.
//
// Semantics mirror middleware.CORS:
//   - No Origin header (curl, ws cli, the eBPF collector) → always
//     allowed. WS upgrade requests are commonly issued without an
//     Origin header by non-browser clients.
//   - allowedOrigins == nil, empty, or contains "*" → wildcard, accept any.
//   - Otherwise, the Origin value must be an exact match for one of
//     the allowed entries (case-insensitive on the scheme/host, the
//     browser always sends a normalized form).
//
// This is the single source of truth for which browser origins may
// open a WS connection. main.go reads CORS_ALLOWED_ORIGINS once and
// hands the resulting slice to both middleware.CORS and NewHub.
func buildCheckOrigin(allowedOrigins []string) func(r *http.Request) bool {
	if len(allowedOrigins) == 0 {
		// Match the CORS middleware's "no config → wildcard" default.
		return func(r *http.Request) bool { return true }
	}
	wildcard := false
	allowed := make(map[string]struct{}, len(allowedOrigins))
	for _, o := range allowedOrigins {
		if o == "*" {
			wildcard = true
			continue
		}
		allowed[strings.ToLower(o)] = struct{}{}
	}
	return func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true // non-browser client, can't be cross-origin by definition
		}
		if wildcard {
			return true
		}
		_, ok := allowed[strings.ToLower(origin)]
		return ok
	}
}
