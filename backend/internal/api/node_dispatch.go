package api

import (
	"net/http"
	"strings"
)

// ServeNodeRoute dispatches /api/nodes/{id}[/{action}] requests to the
// right handler based on method and path suffix.
//
// Method routing:
//   POST   /api/nodes/{id}/activate    -> ServeNodeActivate
//   POST   /api/nodes/{id}/deactivate  -> ServeNodeDeactivate
//   POST   /api/nodes/{id}/register    -> ServeNodeRegister
//   GET    /api/nodes/{id}/status      -> ServeNodeStatus
//   GET    /api/nodes/{id}             -> ServeNodeByID (single fetch)
//   PUT    /api/nodes/{id}             -> ServeNodeByID (update)
//   DELETE /api/nodes/{id}             -> ServeNodeByID (delete)
//
// Anything else returns 405. This is the entry point wired into
// SetupRoutes; we keep it as a method so it can be tested directly
// with httptest instead of standing up the full mux.
func (h *Handler) ServeNodeRoute(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	switch r.Method {
	case http.MethodPost:
		switch {
		case strings.HasSuffix(path, "/activate"):
			h.ServeNodeActivate(w, r)
		case strings.HasSuffix(path, "/deactivate"):
			h.ServeNodeDeactivate(w, r)
		case strings.HasSuffix(path, "/register"):
			h.ServeNodeRegister(w, r)
		default:
			h.writeError(w, r, http.StatusNotFound, "not found")
		}
	case http.MethodGet:
		if strings.HasSuffix(path, "/status") {
			h.ServeNodeStatus(w, r)
			return
		}
		h.ServeNodeByID(w, r)
	case http.MethodPut, http.MethodDelete:
		// ServeNodeByID itself rejects unexpected methods (PATCH etc.)
		// and re-validates the method, so the dispatcher only needs to
		// avoid the blanket 405. Without this branch, frontend edits
		// hit a confusing "POST/GET required" 405.
		h.ServeNodeByID(w, r)
	default:
		h.writeError(w, r, http.StatusMethodNotAllowed, "POST/GET/PUT/DELETE required")
	}
}
