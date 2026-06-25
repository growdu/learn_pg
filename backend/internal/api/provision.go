package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"pg-visualizer-backend/internal/provision"
)

// ─── Request / Response types ────────────────────────────────────────────────

type provisionRuntime struct {
	Type      string `json:"type"`
	PGVersion string `json:"pgVersion"`
}

type provisionSingleRequest struct {
	ProjectID    string           `json:"projectId"`
	ClusterName string           `json:"clusterName"`
	Template    string           `json:"template"`
	Runtime     provisionRuntime `json:"runtime"`
	ProviderType string          `json:"providerType"` // "docker" | "local"
}

type provisionReplicaRequest struct {
	ProjectID   string           `json:"projectId"`
	ClusterName string           `json:"clusterName"`
	Runtime     provisionRuntime `json:"runtime"`
}

// ReplicaProvisionRequest 主备/逻辑复制请求
type ReplicaProvisionRequest struct {
	ProjectID   string `json:"projectId"`
	ClusterName string `json:"clusterName"`
	Type        string `json:"type"` // "physical" | "logical"
	Runtime     RuntimeConfig `json:"runtime"`
}

// RuntimeConfig 运行时配置
type RuntimeConfig struct {
	Type          string `json:"type"`    // "docker"
	PGVersion     string `json:"pgVersion"`
	PrimaryPort   int    `json:"primaryPort"`
	SecondaryPort int    `json:"secondaryPort"`
}

type provisionResponse struct {
	Success             bool     `json:"success"`
	ProjectID           string   `json:"projectId,omitempty"`
	ClusterID           string   `json:"clusterId,omitempty"`
	NodeIDs             []string `json:"nodeIds,omitempty"`
	AutoConnectedNodeID string   `json:"autoConnectedNodeId,omitempty"`
	TaskID              string   `json:"taskId,omitempty"`
	Error               string   `json:"error,omitempty"`
}

// ─── HTTP handlers ───────────────────────────────────────────────────────────

// ServeProvisionSingle handles POST /api/provision/single.
func (h *Handler) ServeProvisionSingle(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		h.writeError(w, r, 405, "POST required")
		return
	}
	var req provisionSingleRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&req); err != nil {
		h.writeError(w, r, 400, "invalid JSON")
		return
	}
	if strings.TrimSpace(req.ProjectID) == "" {
		h.writeError(w, r, 400, "projectId is required")
		return
	}

	taskID := genID("task")
	clusterID := genID("cluster")
	nodeID := genID("node")

	h.setProvisionTask(provisionTask{
		TaskID:    taskID,
		Status:    "running",
		Progress:  5,
		Message:   "starting single-node provision",
		ProjectID: req.ProjectID,
		ClusterID: clusterID,
		StartedAt: time.Now().UnixMilli(),
	})

	providerType := orDefaultStr(req.ProviderType, "docker")
	spec := provision.InstanceSpec{
		Name:      orDefaultStr(strings.TrimSpace(req.ClusterName), "单机集群"),
		PGVersion: orDefaultStr(req.Runtime.PGVersion, "16"),
		Port:      orDefaultInt(h.config.PGPort, 5432),
	}

	h.setProvisionTask(provisionTask{
		TaskID:    taskID,
		Status:    "running",
		Progress:  10,
		Message:   "provisioning PostgreSQL instance",
		ProjectID: req.ProjectID,
		ClusterID: clusterID,
		StartedAt: time.Now().UnixMilli(),
	})

	ctx := r.Context()
	info, err := h.provisionService.StartSingle(ctx, spec, providerType)
	if err != nil {
		h.setProvisionTask(provisionTask{
			TaskID:     taskID,
			Status:     "failed",
			Progress:   100,
			Message:    "provision failed: " + err.Error(),
			ProjectID:  req.ProjectID,
			ClusterID:  clusterID,
			StartedAt:  time.Now().UnixMilli(),
			FinishedAt: time.Now().UnixMilli(),
			Error:      err.Error(),
		})
		h.writeError(w, r, 500, "provision failed: "+err.Error())
		return
	}

	cluster := workspaceCluster{
		ID:              clusterID,
		Name:            orDefaultStr(strings.TrimSpace(req.ClusterName), "单机集群"),
		ReplicationType: "physical",
		ProvisionMode:   "single",
		Runtime: &workspaceRuntime{
			Type:      orDefaultStr(req.Runtime.Type, "local"),
			PGVersion: spec.PGVersion,
		},
		AlertThresholdSec: 30,
		Nodes: []workspaceNode{
			{
				ID:          nodeID,
				Name:        "node-1",
				Host:        info.Host,
				Port:        info.Port,
				User:        orDefaultStr(h.config.PGUser, "postgres"),
				Password:    orDefaultStr(h.config.PGPassword, "postgres"),
				Database:    orDefaultStr(h.config.PGDatabase, "postgres"),
				ClusterType: "physical",
				Role:        "primary",
				Source:      "provisioned",
			},
		},
	}

	h.setProvisionTask(provisionTask{
		TaskID:    taskID,
		Status:    "running",
		Progress:  70,
		Message:   "saving cluster to workspace",
		ProjectID: req.ProjectID,
		ClusterID: cluster.ID,
		StartedAt: time.Now().UnixMilli(),
	})

	if err := h.workspace.appendCluster(req.ProjectID, cluster); err != nil {
		_ = h.provisionService.StopInstance(ctx, info)
		h.setProvisionTask(provisionTask{
			TaskID:     taskID,
			Status:     "failed",
			Progress:   100,
			Message:    "failed to save cluster: " + err.Error(),
			ProjectID:  req.ProjectID,
			ClusterID:  cluster.ID,
			StartedAt:  time.Now().UnixMilli(),
			FinishedAt: time.Now().UnixMilli(),
			Error:      err.Error(),
		})
		h.writeError(w, r, 400, err.Error())
		return
	}

	h.setProvisionTask(provisionTask{
		TaskID:    taskID,
		Status:    "running",
		Progress:  90,
		Message:   "connecting to node",
		ProjectID: req.ProjectID,
		ClusterID: cluster.ID,
		StartedAt: time.Now().UnixMilli(),
	})

	autoConnected := ""
	if len(cluster.Nodes) > 0 && h.tryConnectNode(cluster.Nodes[0]) == nil {
		autoConnected = cluster.Nodes[0].ID
	}

	h.setProvisionTask(provisionTask{
		TaskID:     taskID,
		Status:     "success",
		Progress:   100,
		Message:    "single-node cluster ready",
		ProjectID:  req.ProjectID,
		ClusterID:  cluster.ID,
		StartedAt:  time.Now().UnixMilli(),
		FinishedAt: time.Now().UnixMilli(),
	})

	writeJSON(w, r, 200, provisionResponse{
		Success:             true,
		ProjectID:           req.ProjectID,
		ClusterID:           cluster.ID,
		NodeIDs:             []string{cluster.Nodes[0].ID},
		AutoConnectedNodeID: autoConnected,
		TaskID:              taskID,
	})
}

// ServeProvisionPhysical handles POST /api/provision/physical.
func (h *Handler) ServeProvisionPhysical(w http.ResponseWriter, r *http.Request) {
	var req ReplicaProvisionRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&req); err != nil {
		h.writeError(w, r, 400, "invalid JSON")
		return
	}
	req.Type = "physical"
	h.serveProvisionReplica(w, r, req)
}

// ServeProvisionLogical handles POST /api/provision/logical.
func (h *Handler) ServeProvisionLogical(w http.ResponseWriter, r *http.Request) {
	var req ReplicaProvisionRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&req); err != nil {
		h.writeError(w, r, 400, "invalid JSON")
		return
	}
	req.Type = "logical"
	h.serveProvisionReplica(w, r, req)
}

// serveProvisionReplica handles the common logic for physical and logical replication.
func (h *Handler) serveProvisionReplica(w http.ResponseWriter, r *http.Request, req ReplicaProvisionRequest) {
	if r.Method != "POST" {
		h.writeError(w, r, 405, "POST required")
		return
	}

	replType := strings.ToLower(strings.TrimSpace(req.Type))
	if replType != "physical" && replType != "logical" {
		h.writeError(w, r, 400, "type must be 'physical' or 'logical'")
		return
	}
	if strings.TrimSpace(req.ProjectID) == "" {
		h.writeError(w, r, 400, "projectId is required")
		return
	}

	clusterType := replType
	roleA, roleB := "primary", "standby"
	name := "物理复制集群"
	if replType == "logical" {
		roleA, roleB = "publisher", "subscriber"
		name = "逻辑复制集群"
	}

	taskID := genID("task")
	clusterID := genID("cluster")
	primaryNodeID := genID("node")
	standbyNodeID := genID("node")

	h.setProvisionTask(provisionTask{
		TaskID:    taskID,
		TaskType:  "provision." + replType,
		Status:    "running",
		Progress:  5,
		Message:   "starting " + name,
		ProjectID: req.ProjectID,
		ClusterID: clusterID,
		StartedAt: time.Now().UnixMilli(),
	})

	providerType := orDefaultStr(req.Runtime.Type, "docker")
	primaryPort := req.Runtime.PrimaryPort
	if primaryPort == 0 {
		primaryPort = orDefaultInt(h.config.PGPort, 5432)
	}
	spec := provision.InstanceSpec{
		Name:      orDefaultStr(strings.TrimSpace(req.ClusterName), name),
		PGVersion: orDefaultStr(req.Runtime.PGVersion, "16"),
		Port:      primaryPort,
	}

	h.setProvisionTask(provisionTask{
		TaskID:    taskID,
		TaskType:  "provision." + replType,
		Status:    "running",
		Progress:  10,
		Message:   "starting primary PostgreSQL",
		ProjectID: req.ProjectID,
		ClusterID: clusterID,
		StartedAt: time.Now().UnixMilli(),
	})

	ctx := r.Context()
	primaryInfo, err := h.provisionService.StartSingle(ctx, spec, providerType)
	if err != nil {
		h.setProvisionTask(provisionTask{
			TaskID:     taskID,
			TaskType:   "provision." + replType,
			Status:     "failed",
			Progress:   100,
			Message:    "failed to start primary: " + err.Error(),
			ProjectID:  req.ProjectID,
			ClusterID:  clusterID,
			StartedAt:  time.Now().UnixMilli(),
			FinishedAt: time.Now().UnixMilli(),
			Error:      err.Error(),
		})
		h.writeError(w, r, 500, "failed to start primary: "+err.Error())
		return
	}

	h.setProvisionTask(provisionTask{
		TaskID:    taskID,
		TaskType:  "provision." + replType,
		Status:    "running",
		Progress:  30,
		Message:   "waiting for primary to be ready",
		ProjectID: req.ProjectID,
		ClusterID: clusterID,
		StartedAt: time.Now().UnixMilli(),
	})

	if err := waitForPostgres(ctx, primaryInfo.Host, primaryInfo.Port); err != nil {
		_ = h.provisionService.StopInstance(ctx, primaryInfo)
		h.setProvisionTask(provisionTask{
			TaskID:     taskID,
			TaskType:   "provision." + replType,
			Status:     "failed",
			Progress:   100,
			Message:    "primary not ready: " + err.Error(),
			ProjectID:  req.ProjectID,
			ClusterID:  clusterID,
			StartedAt:  time.Now().UnixMilli(),
			FinishedAt: time.Now().UnixMilli(),
			Error:      err.Error(),
		})
		h.writeError(w, r, 500, "primary not ready: "+err.Error())
		return
	}

	h.setProvisionTask(provisionTask{
		TaskID:    taskID,
		TaskType:  "provision." + replType,
		Status:    "running",
		Progress:  40,
		Message:   "starting standby/subscriber",
		ProjectID: req.ProjectID,
		ClusterID: clusterID,
		StartedAt: time.Now().UnixMilli(),
	})

	provider, ok := h.provisionService.GetReplicationProvider("docker-replication")
	if !ok {
		_ = h.provisionService.StopInstance(ctx, primaryInfo)
		h.setProvisionTask(provisionTask{
			TaskID:     taskID,
			TaskType:   "provision." + replType,
			Status:     "failed",
			Progress:   100,
			Message:    "docker-replication provider not available",
			ProjectID:  req.ProjectID,
			ClusterID:  clusterID,
			StartedAt:  time.Now().UnixMilli(),
			FinishedAt: time.Now().UnixMilli(),
			Error:      "docker-replication provider not available",
		})
		h.writeError(w, r, 500, "docker-replication provider not available")
		return
	}

	secondaryPort := req.Runtime.SecondaryPort
	if secondaryPort == 0 {
		secondaryPort = primaryPort + 1
	}

	replSpec := provision.ReplicationSpec{
		Name:          orDefaultStr(strings.TrimSpace(req.ClusterName), name),
		Type:          replType,
		PGVersion:     orDefaultStr(req.Runtime.PGVersion, "16"),
		PrimaryPort:   primaryInfo.Port,
		SecondaryPort: secondaryPort,
		ProviderID:    "docker-replication",
	}

	replicaInfo, err := provider.StartReplica(ctx, replSpec, primaryInfo)
	if err != nil {
		_ = h.provisionService.StopInstance(ctx, primaryInfo)
		h.setProvisionTask(provisionTask{
			TaskID:     taskID,
			TaskType:   "provision." + replType,
			Status:     "failed",
			Progress:   100,
			Message:    "failed to start replica: " + err.Error(),
			ProjectID:  req.ProjectID,
			ClusterID:  clusterID,
			StartedAt:  time.Now().UnixMilli(),
			FinishedAt: time.Now().UnixMilli(),
			Error:      err.Error(),
		})
		h.writeError(w, r, 500, "failed to start replica: "+err.Error())
		return
	}

	cluster := workspaceCluster{
		ID:              clusterID,
		Name:            orDefaultStr(strings.TrimSpace(req.ClusterName), name),
		ReplicationType: clusterType,
		ProvisionMode:   replType,
		ProvisionTaskID:  taskID,
		Runtime: &workspaceRuntime{
			Type:      providerType,
			PGVersion: orDefaultStr(req.Runtime.PGVersion, "16"),
		},
		AlertThresholdSec: 30,
		Nodes: []workspaceNode{
			{
				ID:          primaryNodeID,
				Name:        roleA + "-1",
				Host:        primaryInfo.Host,
				Port:        primaryInfo.Port,
				User:        orDefaultStr(h.config.PGUser, "postgres"),
				Password:    orDefaultStr(h.config.PGPassword, "postgres"),
				Database:    orDefaultStr(h.config.PGDatabase, "postgres"),
				ClusterType: clusterType,
				Role:        roleA,
				Source:      "provisioned",
			},
			{
				ID:          standbyNodeID,
				Name:        roleB + "-1",
				Host:        replicaInfo.SecondaryInfo.Host,
				Port:        replicaInfo.SecondaryInfo.Port,
				User:        orDefaultStr(h.config.PGUser, "postgres"),
				Password:    orDefaultStr(h.config.PGPassword, "postgres"),
				Database:    orDefaultStr(h.config.PGDatabase, "postgres"),
				ClusterType: clusterType,
				Role:        roleB,
				Source:      "provisioned",
			},
		},
	}

	h.setProvisionTask(provisionTask{
		TaskID:    taskID,
		TaskType:  "provision." + replType,
		Status:    "running",
		Progress:  60,
		Message:   "saving cluster to workspace",
		ProjectID: req.ProjectID,
		ClusterID: cluster.ID,
		StartedAt: time.Now().UnixMilli(),
	})

	if err := h.workspace.appendCluster(req.ProjectID, cluster); err != nil {
		_ = provider.StopReplica(ctx, replicaInfo)
		_ = h.provisionService.StopInstance(ctx, primaryInfo)
		h.setProvisionTask(provisionTask{
			TaskID:     taskID,
			TaskType:   "provision." + replType,
			Status:     "failed",
			Progress:   100,
			Message:    "failed to save cluster: " + err.Error(),
			ProjectID:  req.ProjectID,
			ClusterID:  cluster.ID,
			StartedAt:  time.Now().UnixMilli(),
			FinishedAt: time.Now().UnixMilli(),
			Error:      err.Error(),
		})
		h.writeError(w, r, 400, err.Error())
		return
	}

	h.setProvisionTask(provisionTask{
		TaskID:    taskID,
		TaskType:  "provision." + replType,
		Status:    "running",
		Progress:  70,
		Message:   "connecting to nodes",
		ProjectID: req.ProjectID,
		ClusterID: cluster.ID,
		StartedAt: time.Now().UnixMilli(),
	})

	autoConnected := ""
	if len(cluster.Nodes) > 0 && h.tryConnectNode(cluster.Nodes[0]) == nil {
		autoConnected = cluster.Nodes[0].ID
	}

	h.setProvisionTask(provisionTask{
		TaskID:     taskID,
		TaskType:   "provision." + replType,
		Status:     "success",
		Progress:   100,
		Message:    "replicated cluster ready",
		ProjectID:  req.ProjectID,
		ClusterID:  cluster.ID,
		NodeIDs:    []string{cluster.Nodes[0].ID, cluster.Nodes[1].ID},
		StartedAt:  time.Now().UnixMilli(),
		FinishedAt: time.Now().UnixMilli(),
	})

	writeJSON(w, r, 200, provisionResponse{
		Success:             true,
		ProjectID:           req.ProjectID,
		ClusterID:           cluster.ID,
		NodeIDs:             []string{cluster.Nodes[0].ID, cluster.Nodes[1].ID},
		AutoConnectedNodeID: autoConnected,
		TaskID:              taskID,
	})
}

// ServeProvisionTask handles GET /api/provision/tasks/{id}.
func (h *Handler) ServeProvisionTask(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		h.writeError(w, r, 405, "GET required")
		return
	}
	taskID := strings.TrimPrefix(r.URL.Path, "/api/provision/tasks/")
	taskID = strings.TrimSpace(taskID)
	if taskID == "" {
		h.writeError(w, r, 400, "taskId is required")
		return
	}
	task, ok := h.getProvisionTask(taskID)
	if !ok {
		h.writeError(w, r, 404, "task not found")
		return
	}
	writeJSON(w, r, 200, map[string]any{
		"success": true,
		"task":    task,
	})
}

// ServeProvisionTasks handles GET /api/provision/tasks.
func (h *Handler) ServeProvisionTasks(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		h.writeError(w, r, 405, "GET required")
		return
	}
	limit := 20
	statusFilter := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("status")))
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	items, summary := h.listProvisionTasks(limit, statusFilter)
	writeJSON(w, r, 200, map[string]any{
		"success": true,
		"tasks":   items,
		"count":   len(items),
		"summary": summary,
	})
}
