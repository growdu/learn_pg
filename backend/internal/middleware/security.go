package middleware

import "net/http"

// Security sets baseline hardening response headers on every reply.
//
// The backend serves a JSON API; nothing the server emits contains
// executable HTML, so we lock down the typical browser-attack
// surfaces:
//   - X-Content-Type-Options: nosniff - block MIME sniffing.
//   - X-Frame-Options: DENY - never permit this backend to be
//     embedded in an iframe (it serves API only).
//   - Referrer-Policy: no-referrer - don't leak API paths in the
//     Referer header when a browser navigates away from a 200 page.
//   - Content-Security-Policy: default-src 'none' - the API never
//     renders HTML or runs script, so the strictest possible policy
//     is correct here. Browsers will reject any resource that tries
//     to load HTML/JS from a successful API response.
func Security(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}
