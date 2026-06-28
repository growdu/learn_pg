package api

import (
	"net/http"

	"pg-visualizer-backend/internal/metrics"
)

// metricsHandler returns the /metrics handler wrapped in a small
// access-log middleware so operators can confirm scrapes are happening.
// This handler is intentionally NOT exposed via any auth wrapper; it is
// expected to be reachable from inside the cluster only (firewall, k8s
// NetworkPolicy, or scraped via the sidecar).
func (h *Handler) metricsHandler() http.Handler {
	mw := metrics.HTTPMiddleware
	// We register the snapshot provider lazily because at construction
	// time the connection manager / hub are present but not yet "running"
	// in the sense the metrics care about.
	metrics.SnapshotProvider = h.metricsSnapshot
	return mw(metrics.Handler())
}

// metricsSnapshot gathers the latest counts for the service-level gauges.
// Failures are swallowed — gauges just stay at their last value.
func (h *Handler) metricsSnapshot() metrics.Snapshot {
	snap := metrics.Snapshot{}
	if h.workspace != nil {
		items, err := h.workspace.readAll()
		if err == nil {
			snap.WorkspaceProjects = len(items)
		}
	}
	if h.hub != nil {
		snap.ActiveWSClients = h.hub.ClientCount()
	}
	if h.connMgr != nil {
		snap.ActivePGConns = h.connMgr.Count()
	}
	h.taskMu.Lock()
	snap.ProvisionTasks = len(h.tasks)
	h.taskMu.Unlock()
	return snap
}

// ServeVersion handles GET /version — exposes build-time metadata so
// operators can confirm which commit is running without SSHing in.
// Values are injected via -ldflags at build time; defaults are "dev".
func (h *Handler) ServeVersion(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, r, http.StatusOK, map[string]string{
		"version":    metrics.BuildInfo.Version,
		"commit":     metrics.BuildInfo.Commit,
		"build_date": metrics.BuildInfo.BuildDate,
		"go_version": metrics.BuildInfo.GoVersion,
	})
}