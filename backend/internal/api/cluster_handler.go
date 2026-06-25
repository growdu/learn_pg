package api

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"pg-visualizer-backend/internal/provision"
)

// ServeClusterTeardown handles POST /api/clusters/{id}/teardown.
// It stops all node instances and removes the cluster from the workspace.
func (h *Handler) ServeClusterTeardown(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		h.writeError(w, r, http.StatusMethodNotAllowed, "POST required")
		return
	}

	// Extract cluster ID from path: /api/clusters/{id}/teardown
	clusterID := strings.TrimPrefix(r.URL.Path, "/api/clusters/")
	clusterID = strings.TrimSuffix(clusterID, "/teardown")
	clusterID = strings.TrimSpace(clusterID)
	if clusterID == "" {
		h.writeError(w, r, http.StatusBadRequest, "cluster id is required")
		return
	}

	var req struct {
		CleanupData bool `json:"cleanupData"`
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64*1024))
	if err != nil {
		h.writeError(w, r, http.StatusBadRequest, "failed to read body")
		return
	}
	defer r.Body.Close()
	if len(body) > 0 {
		if err := json.Unmarshal(body, &req); err != nil {
			h.writeError(w, r, http.StatusBadRequest, "invalid JSON")
			return
		}
	}

	// Find cluster in workspace
	cluster, projectID, err := h.findClusterByID(clusterID)
	if err != nil {
		h.writeError(w, r, http.StatusInternalServerError, err.Error())
		return
	}
	if cluster == nil {
		h.writeError(w, r, http.StatusNotFound, "cluster not found")
		return
	}

	// Stop each node's instance
	for _, node := range cluster.Nodes {
		// Infer provider from host: localhost → docker, otherwise ssh-based
		providerID := "docker"
		if node.Host != "localhost" && node.Host != "127.0.0.1" && node.Host != "" {
			providerID = "ssh"
		}
		info := provision.InstanceInfo{
			ProviderID:  providerID,
			ContainerID: node.ID,
			Host:        node.Host,
			Port:        node.Port,
			DataDir:     "",
		}
		if err := h.provisionService.StopInstance(r.Context(), info); err != nil {
			slog.Warn("failed to stop instance", "node", node.ID, "error", err)
		}
	}

	// Delete cluster from workspace
	if err := h.workspace.DeleteClusterLocked(projectID, clusterID); err != nil {
		h.writeError(w, r, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, r, http.StatusOK, map[string]interface{}{
		"success": true,
		"cleaned": req.CleanupData,
	})
}