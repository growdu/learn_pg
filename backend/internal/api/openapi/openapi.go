// Package openapi serves the backend's OpenAPI 3.0 spec from
// /api/openapi.json. The spec is hand-written rather than generated
// because:
//
//   - Most endpoints take a tiny JSON body whose shape is documented
//     in the doc comment of the handler. A generator would have to
//     parse the source to extract that, which is more code than the
//     spec itself.
//   - The /ws endpoint is described in the spec for completeness
//     even though it isn't a regular HTTP request/response, so
//     clients can discover the upgrade URL and protocol name.
//   - We want this to be readable: an OpenAPI spec that drifts from
//     the code is worse than no spec. Hand-writing forces the
//     author to think about whether a field still exists.
//
// To regenerate the spec after editing this file:
//
//   go run ./cmd/openapi-lint
package openapi

import (
	_ "embed"
	"net/http"
)

//go:embed spec.json
var specJSON []byte

// Handler returns an http.HandlerFunc that serves the embedded
// OpenAPI 3.0 spec with the correct content-type and cache-control.
func Handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		// Spec is rebuilt on every release; cache it for a day so
		// tooling refreshes at most once per day.
		w.Header().Set("Cache-Control", "public, max-age=86400")
		w.WriteHeader(http.StatusOK)
		if r.Method == http.MethodHead {
			return
		}
		w.Write(specJSON)
	}
}
