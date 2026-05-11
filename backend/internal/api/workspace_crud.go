package api

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

// ─── ID extraction helpers ────────────────────────────────────────────────────

func projectIDFromPath(path string) string {
	parts := strings.TrimPrefix(path, "/api/projects/")
	i := strings.Index(parts, "/")
	if i >= 0 {
		return parts[:i]
	}
	return strings.TrimSpace(parts)
}

func clusterIDFromPath(path string) string {
	parts := strings.TrimPrefix(path, "/api/clusters/")
	i := strings.Index(parts, "/")
	if i >= 0 {
		return parts[:i]
	}
	return strings.TrimSpace(parts)
}

func nodeIDFromPath(path string) string {
	parts := strings.TrimPrefix(path, "/api/nodes/")
	i := strings.Index(parts, "/")
	if i >= 0 {
		return parts[:i]
	}
	return strings.TrimSpace(parts)
}

// ─── Request types ─────────────────────────────────────────────────────────────

type ProjectCreateRequest struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type ProjectUpdateRequest struct {
	Name *string `json:"name,omitempty"`
}

type ClusterCreateRequest struct {
	ID                string         `json:"id"`
	Name              string         `json:"name"`
	ReplicationType   string         `json:"replicationType"`
	AlertThresholdSec int            `json:"alertThresholdSec"`
	Nodes             []workspaceNode `json:"nodes"`
}

type ClusterUpdateRequest struct {
	Name              *string `json:"name,omitempty"`
	ReplicationType  *string `json:"replicationType,omitempty"`
	AlertThresholdSec *int    `json:"alertThresholdSec,omitempty"`
}

type NodeCreateRequest struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Host        string `json:"host"`
	Port        int    `json:"port"`
	User        string `json:"user"`
	Password    string `json:"password"`
	Database    string `json:"database"`
	ClusterType string `json:"clusterType"`
	Role        string `json:"role"`
}

type NodeUpdateRequest struct {
	Name     *string `json:"name,omitempty"`
	Host     *string `json:"host,omitempty"`
	Port     *int    `json:"port,omitempty"`
	User     *string `json:"user,omitempty"`
	Password *string `json:"password,omitempty"`
	Database *string `json:"database,omitempty"`
}

// ─── findClusterByID ──────────────────────────────────────────────────────────

// findClusterByID searches across all projects to find a cluster by its ID.
// Returns (cluster, projectID) if found, or (nil, "") if not found.
func (h *Handler) findClusterByID(clusterID string) (*workspaceCluster, string, error) {
	projects, err := h.workspace.readAll()
	if err != nil {
		return nil, "", err
	}
	for _, p := range projects {
		for _, c := range p.Clusters {
			if c.ID == clusterID {
				return &c, p.ID, nil
			}
		}
	}
	return nil, "", nil
}

// ─── ServeProjectList ─────────────────────────────────────────────────────────

// ServeProjectList handles GET /api/projects (list) and POST /api/projects (create).
func (h *Handler) ServeProjectList(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		projects, err := h.workspace.readAll()
		if err != nil {
			h.writeError(w, r, http.StatusInternalServerError, "failed to read projects: "+err.Error())
			return
		}
		// Mask passwords before returning
		masked := make([]workspaceProject, len(projects))
		for i := range projects {
			masked[i] = projects[i]
			maskedClusters := make([]workspaceCluster, len(projects[i].Clusters))
			for j := range projects[i].Clusters {
				maskedClusters[j] = MaskCluster(projects[i].Clusters[j])
			}
			masked[i].Clusters = maskedClusters
		}
		writeJSON(w, r, http.StatusOK, map[string]interface{}{
			"success":  true,
			"projects": masked,
		})
		return

	case http.MethodPost:
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1024*1024))
		if err != nil {
			h.writeError(w, r, http.StatusBadRequest, "failed to read body")
			return
		}
		defer r.Body.Close()

		var req ProjectCreateRequest
		if err := json.Unmarshal(body, &req); err != nil {
			h.writeError(w, r, http.StatusBadRequest, "invalid JSON")
			return
		}
		if strings.TrimSpace(req.ID) == "" {
			h.writeError(w, r, http.StatusBadRequest, "id is required")
			return
		}
		if strings.TrimSpace(req.Name) == "" {
			h.writeError(w, r, http.StatusBadRequest, "name is required")
			return
		}

		project := workspaceProject{
			ID:         req.ID,
			Name:       req.Name,
			Clusters:   []workspaceCluster{},
			Components: []workspaceComponent{},
		}
		if err := h.workspace.upsert(project); err != nil {
			h.writeError(w, r, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, r, http.StatusCreated, map[string]interface{}{
			"success":  true,
			"project":  MaskProject(project),
		})
		return

	default:
		h.writeError(w, r, http.StatusMethodNotAllowed, "GET/POST required")
		return
	}
}

// MaskProject returns a copy of the project with all cluster/node passwords masked.
func MaskProject(p workspaceProject) workspaceProject {
	maskedClusters := make([]workspaceCluster, len(p.Clusters))
	for i := range p.Clusters {
		maskedClusters[i] = MaskCluster(p.Clusters[i])
	}
	p.Clusters = maskedClusters
	return p
}

// ─── ServeProjectByID ─────────────────────────────────────────────────────────

// ServeProjectByID handles GET, PUT, DELETE /api/projects/{id} and POST /api/projects/{id}/clusters.
func (h *Handler) ServeProjectByID(w http.ResponseWriter, r *http.Request) {
	id := projectIDFromPath(r.URL.Path)
	if id == "" {
		h.writeError(w, r, http.StatusBadRequest, "project id is required")
		return
	}

	switch r.Method {
	case http.MethodGet:
		project, err := h.workspace.GetProject(id)
		if err != nil {
			h.writeError(w, r, http.StatusInternalServerError, "failed to get project: "+err.Error())
			return
		}
		if project == nil {
			h.writeError(w, r, http.StatusNotFound, "project not found")
			return
		}
		writeJSON(w, r, http.StatusOK, map[string]interface{}{
			"success":  true,
			"project":  MaskProject(*project),
		})
		return

	case http.MethodPut:
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1024*1024))
		if err != nil {
			h.writeError(w, r, http.StatusBadRequest, "failed to read body")
			return
		}
		defer r.Body.Close()

		var req ProjectUpdateRequest
		if err := json.Unmarshal(body, &req); err != nil {
			h.writeError(w, r, http.StatusBadRequest, "invalid JSON")
			return
		}

		err = h.workspace.UpdateProjectLocked(id, func(p *workspaceProject) error {
			if req.Name != nil {
				p.Name = *req.Name
			}
			return nil
		})
		if err != nil {
			h.writeError(w, r, http.StatusNotFound, err.Error())
			return
		}
		project, _ := h.workspace.GetProject(id)
		writeJSON(w, r, http.StatusOK, map[string]interface{}{
			"success":  true,
			"project":  MaskProject(*project),
		})
		return

	case http.MethodDelete:
		if err := h.workspace.DeleteProjectLocked(id); err != nil {
			h.writeError(w, r, http.StatusNotFound, err.Error())
			return
		}
		writeJSON(w, r, http.StatusOK, map[string]interface{}{
			"success": true,
		})
		return

	case http.MethodPost:
		// POST /api/projects/{id}/clusters — delegate to ServeClusterCreate
		h.ServeClusterCreate(w, r)
		return

	default:
		h.writeError(w, r, http.StatusMethodNotAllowed, "GET/PUT/DELETE/POST required")
		return
	}
}

// ─── ServeClusterCreate ───────────────────────────────────────────────────────

// ServeClusterCreate handles POST /api/projects/{id}/clusters.
func (h *Handler) ServeClusterCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		h.writeError(w, r, http.StatusMethodNotAllowed, "POST required")
		return
	}

	projectID := projectIDFromPath(r.URL.Path)
	if projectID == "" {
		h.writeError(w, r, http.StatusBadRequest, "project id is required")
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1024*1024))
	if err != nil {
		h.writeError(w, r, http.StatusBadRequest, "failed to read body")
		return
	}
	defer r.Body.Close()

	var req ClusterCreateRequest
	if err := json.Unmarshal(body, &req); err != nil {
		h.writeError(w, r, http.StatusBadRequest, "invalid JSON")
		return
	}
	if strings.TrimSpace(req.ID) == "" {
		h.writeError(w, r, http.StatusBadRequest, "cluster id is required")
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		h.writeError(w, r, http.StatusBadRequest, "cluster name is required")
		return
	}

	cluster := workspaceCluster{
		ID:                req.ID,
		Name:              req.Name,
		ReplicationType:   req.ReplicationType,
		AlertThresholdSec: req.AlertThresholdSec,
		Nodes:             req.Nodes,
	}
	if cluster.AlertThresholdSec <= 0 {
		cluster.AlertThresholdSec = 30
	}

	if err := h.workspace.appendCluster(projectID, cluster); err != nil {
		h.writeError(w, r, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, r, http.StatusCreated, map[string]interface{}{
		"success":  true,
		"cluster":  MaskCluster(cluster),
	})
}

// ─── ServeClusterByID ─────────────────────────────────────────────────────────

// ServeClusterByID handles PUT, DELETE /api/clusters/{id} and POST /api/clusters/{id}/nodes.
func (h *Handler) ServeClusterByID(w http.ResponseWriter, r *http.Request) {
	clusterID := clusterIDFromPath(r.URL.Path)
	if clusterID == "" {
		h.writeError(w, r, http.StatusBadRequest, "cluster id is required")
		return
	}

	switch r.Method {
	case http.MethodPut:
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1024*1024))
		if err != nil {
			h.writeError(w, r, http.StatusBadRequest, "failed to read body")
			return
		}
		defer r.Body.Close()

		var req ClusterUpdateRequest
		if err := json.Unmarshal(body, &req); err != nil {
			h.writeError(w, r, http.StatusBadRequest, "invalid JSON")
			return
		}

		cluster, projectID, err := h.findClusterByID(clusterID)
		if err != nil {
			h.writeError(w, r, http.StatusInternalServerError, "failed to find cluster: "+err.Error())
			return
		}
		if cluster == nil {
			h.writeError(w, r, http.StatusNotFound, "cluster not found")
			return
		}

		err = h.workspace.UpdateClusterLocked(projectID, clusterID, func(c *workspaceCluster) error {
			if req.Name != nil {
				c.Name = *req.Name
			}
			if req.ReplicationType != nil {
				c.ReplicationType = *req.ReplicationType
			}
			if req.AlertThresholdSec != nil {
				c.AlertThresholdSec = *req.AlertThresholdSec
			}
			return nil
		})
		if err != nil {
			h.writeError(w, r, http.StatusInternalServerError, err.Error())
			return
		}
		updated, _, _ := h.findClusterByID(clusterID)
		writeJSON(w, r, http.StatusOK, map[string]interface{}{
			"success":  true,
			"cluster":  MaskCluster(*updated),
		})
		return

	case http.MethodDelete:
		cluster, projectID, err := h.findClusterByID(clusterID)
		if err != nil {
			h.writeError(w, r, http.StatusInternalServerError, "failed to find cluster: "+err.Error())
			return
		}
		if cluster == nil {
			h.writeError(w, r, http.StatusNotFound, "cluster not found")
			return
		}
		if err := h.workspace.DeleteClusterLocked(projectID, clusterID); err != nil {
			h.writeError(w, r, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, r, http.StatusOK, map[string]interface{}{
			"success": true,
		})
		return

	case http.MethodPost:
		// POST /api/clusters/{id}/nodes — delegate to ServeNodeCreate
		h.ServeNodeCreate(w, r)
		return

	default:
		h.writeError(w, r, http.StatusMethodNotAllowed, "PUT/DELETE/POST required")
		return
	}
}

// ─── ServeNodeCreate ──────────────────────────────────────────────────────────

// ServeNodeCreate handles POST /api/clusters/{id}/nodes.
func (h *Handler) ServeNodeCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		h.writeError(w, r, http.StatusMethodNotAllowed, "POST required")
		return
	}

	clusterID := clusterIDFromPath(r.URL.Path)
	if clusterID == "" {
		h.writeError(w, r, http.StatusBadRequest, "cluster id is required")
		return
	}

	// find projectID for this cluster
	cluster, projectID, err := h.findClusterByID(clusterID)
	if err != nil {
		h.writeError(w, r, http.StatusInternalServerError, "failed to find cluster: "+err.Error())
		return
	}
	if cluster == nil {
		h.writeError(w, r, http.StatusNotFound, "cluster not found")
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1024*1024))
	if err != nil {
		h.writeError(w, r, http.StatusBadRequest, "failed to read body")
		return
	}
	defer r.Body.Close()

	var req NodeCreateRequest
	if err := json.Unmarshal(body, &req); err != nil {
		h.writeError(w, r, http.StatusBadRequest, "invalid JSON")
		return
	}
	if strings.TrimSpace(req.ID) == "" {
		h.writeError(w, r, http.StatusBadRequest, "node id is required")
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		h.writeError(w, r, http.StatusBadRequest, "node name is required")
		return
	}

	node := workspaceNode{
		ID:          req.ID,
		Name:        req.Name,
		Host:        req.Host,
		Port:        req.Port,
		User:        req.User,
		Password:    req.Password,
		Database:    req.Database,
		ClusterType: req.ClusterType,
		Role:        req.Role,
	}

	if err := h.workspace.appendNode(projectID, clusterID, node); err != nil {
		h.writeError(w, r, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, r, http.StatusCreated, map[string]interface{}{
		"success": true,
		"node":    MaskNode(node),
	})
}

// ─── ServeNodeByID ─────────────────────────────────────────────────────────────

// ServeNodeByID handles PUT, DELETE /api/nodes/{id}.
func (h *Handler) ServeNodeByID(w http.ResponseWriter, r *http.Request) {
	nodeID := nodeIDFromPath(r.URL.Path)
	if nodeID == "" {
		h.writeError(w, r, http.StatusBadRequest, "node id is required")
		return
	}

	// Find which project/cluster this node belongs to
	projects, err := h.workspace.readAll()
	if err != nil {
		h.writeError(w, r, http.StatusInternalServerError, "failed to read workspace: "+err.Error())
		return
	}

	var projectID, clusterID string
	var targetNode *workspaceNode
outer:
	for _, p := range projects {
		for _, c := range p.Clusters {
			for i := range c.Nodes {
				if c.Nodes[i].ID == nodeID {
					projectID = p.ID
					clusterID = c.ID
					targetNode = &c.Nodes[i]
					break outer
				}
			}
		}
	}

	if targetNode == nil {
		h.writeError(w, r, http.StatusNotFound, "node not found")
		return
	}

	switch r.Method {
	case http.MethodPut:
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1024*1024))
		if err != nil {
			h.writeError(w, r, http.StatusBadRequest, "failed to read body")
			return
		}
		defer r.Body.Close()

		var req NodeUpdateRequest
		if err := json.Unmarshal(body, &req); err != nil {
			h.writeError(w, r, http.StatusBadRequest, "invalid JSON")
			return
		}

		err = h.workspace.UpdateNodeLocked(projectID, clusterID, nodeID, func(n *workspaceNode) error {
			if req.Name != nil {
				n.Name = *req.Name
			}
			if req.Host != nil {
				n.Host = *req.Host
			}
			if req.Port != nil {
				n.Port = *req.Port
			}
			if req.User != nil {
				n.User = *req.User
			}
			if req.Password != nil {
				n.Password = *req.Password
			}
			if req.Database != nil {
				n.Database = *req.Database
			}
			return nil
		})
		if err != nil {
			h.writeError(w, r, http.StatusInternalServerError, err.Error())
			return
		}
		// Re-fetch updated node
		updated, err := h.workspace.GetNode(projectID, clusterID, nodeID)
		if err != nil || updated == nil {
			h.writeError(w, r, http.StatusInternalServerError, "failed to get updated node")
			return
		}
		writeJSON(w, r, http.StatusOK, map[string]interface{}{
			"success": true,
			"node":    MaskNode(*updated),
		})
		return

	case http.MethodDelete:
		if err := h.workspace.DeleteNodeLocked(projectID, clusterID, nodeID); err != nil {
			h.writeError(w, r, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, r, http.StatusOK, map[string]interface{}{
			"success": true,
		})
		return

	default:
		h.writeError(w, r, http.StatusMethodNotAllowed, "PUT/DELETE required")
		return
	}
}
