package api

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"pg-visualizer-backend/internal/connection"
)

// extractNodeID extracts the node ID from a path like /api/nodes/{id}/activate.
func extractNodeID(path string) string {
	parts := strings.TrimPrefix(path, "/api/nodes/")
	i := strings.Index(parts, "/")
	if i >= 0 {
		return parts[:i]
	}
	return strings.TrimSpace(parts)
}

// ServeNodeActivate handles POST /api/nodes/{id}/activate.
func (h *Handler) ServeNodeActivate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		h.writeError(w, r, http.StatusMethodNotAllowed, "POST required")
		return
	}

	nodeID := extractNodeID(r.URL.Path)
	if nodeID == "" {
		h.writeError(w, r, http.StatusBadRequest, "node id is required")
		return
	}

	// Find the node in the workspace to get its connection config
	projects, err := h.workspace.readAll()
	if err != nil {
		h.writeError(w, r, http.StatusInternalServerError, "failed to read workspace: "+err.Error())
		return
	}

	var targetNode *workspaceNode
outer:
	for _, p := range projects {
		for _, c := range p.Clusters {
			for i := range c.Nodes {
				if c.Nodes[i].ID == nodeID {
					nodeCopy := c.Nodes[i]
					targetNode = &nodeCopy
					break outer
				}
			}
		}
	}
	if targetNode == nil {
		h.writeError(w, r, http.StatusNotFound, "node not found")
		return
	}

	// Build connection config from workspace node
	cfg := connection.Config{
		Host:     targetNode.Host,
		Port:     targetNode.Port,
		User:     targetNode.User,
		Password: targetNode.Password,
		Database: targetNode.Database,
	}

	// Register config with connMgr (idempotent)
	h.connMgr.Register(nodeID, cfg)

	// Update status to "connecting"
	if err := h.workspace.UpdateNodeStatus(nodeID, "connecting", ""); err != nil {
		h.writeError(w, r, http.StatusInternalServerError, "failed to update node status: "+err.Error())
		return
	}

	// Activate the connection
	if err := h.connMgr.Activate(nodeID); err != nil {
		h.workspace.UpdateNodeStatus(nodeID, "failed", err.Error())
		h.writeError(w, r, http.StatusInternalServerError, "activation failed: "+err.Error())
		return
	}

	// Activation succeeded — update status to "ready"
	h.workspace.UpdateNodeStatus(nodeID, "ready", "")

	var version, dataDir string
	if targetNode.InstanceMeta != nil {
		version = targetNode.InstanceMeta.Version
		dataDir = targetNode.InstanceMeta.DataDir
	}

	writeJSON(w, r, http.StatusOK, map[string]interface{}{
		"success": true,
		"version": version,
		"dataDir": dataDir,
	})
}

// ServeNodeStatus handles GET /api/nodes/{id}/status.
func (h *Handler) ServeNodeStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		h.writeError(w, r, http.StatusMethodNotAllowed, "GET required")
		return
	}

	nodeID := extractNodeID(r.URL.Path)
	if nodeID == "" {
		h.writeError(w, r, http.StatusBadRequest, "node id is required")
		return
	}

	// Find the node's current status from workspace
	projects, err := h.workspace.readAll()
	if err != nil {
		h.writeError(w, r, http.StatusInternalServerError, "failed to read workspace: "+err.Error())
		return
	}

	var workspaceStatus, lastError string
	found := false
	for _, p := range projects {
		for _, c := range p.Clusters {
			for _, n := range c.Nodes {
				if n.ID == nodeID {
					workspaceStatus = n.ConnectionStatus
					lastError = n.LastError
					found = true
					break
				}
			}
		}
	}
	if !found {
		h.writeError(w, r, http.StatusNotFound, "node not found")
		return
	}

	// Check actual connection health via connMgr
	healthy := false
	if _, healthErr := h.connMgr.Health(nodeID); healthErr == nil {
		healthy = true
	}

	writeJSON(w, r, http.StatusOK, map[string]interface{}{
		"success":          true,
		"connectionStatus": workspaceStatus,
		"healthy":          healthy,
		"lastError":        lastError,
	})
}

// ServeNodeDeactivate handles POST /api/nodes/{id}/deactivate.
func (h *Handler) ServeNodeDeactivate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		h.writeError(w, r, http.StatusMethodNotAllowed, "POST required")
		return
	}

	nodeID := extractNodeID(r.URL.Path)
	if nodeID == "" {
		h.writeError(w, r, http.StatusBadRequest, "node id is required")
		return
	}

	if err := h.connMgr.Deactivate(nodeID); err != nil {
		h.writeError(w, r, http.StatusInternalServerError, "deactivate failed: "+err.Error())
		return
	}

	h.workspace.UpdateNodeStatus(nodeID, "unknown", "")

	writeJSON(w, r, http.StatusOK, map[string]interface{}{
		"success": true,
	})
}

// ServeNodeRegister handles POST /api/nodes/{id}/register.
func (h *Handler) ServeNodeRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		h.writeError(w, r, http.StatusMethodNotAllowed, "POST required")
		return
	}

	nodeID := extractNodeID(r.URL.Path)
	if nodeID == "" {
		h.writeError(w, r, http.StatusBadRequest, "node id is required")
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1024*1024))
	if err != nil {
		h.writeError(w, r, http.StatusBadRequest, "failed to read body")
		return
	}
	defer r.Body.Close()

	var req struct {
		Host     string `json:"host"`
		Port     int    `json:"port"`
		User     string `json:"user"`
		Password string `json:"password"`
		Database string `json:"database"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		h.writeError(w, r, http.StatusBadRequest, "invalid JSON")
		return
	}
	if strings.TrimSpace(req.Host) == "" {
		h.writeError(w, r, http.StatusBadRequest, "host is required")
		return
	}
	if req.Port <= 0 {
		h.writeError(w, r, http.StatusBadRequest, "port is required")
		return
	}

	cfg := connection.Config{
		Host:     req.Host,
		Port:     req.Port,
		User:     req.User,
		Password: req.Password,
		Database: req.Database,
	}

	h.connMgr.Register(nodeID, cfg)

	writeJSON(w, r, http.StatusOK, map[string]interface{}{
		"success": true,
	})
}