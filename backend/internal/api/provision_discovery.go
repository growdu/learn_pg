package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"pg-visualizer-backend/internal/connection"
	"pg-visualizer-backend/internal/pg"
	"pg-visualizer-backend/internal/provision"
)

type provisionRuntime struct {
	Type      string `json:"type"`
	PGVersion string `json:"pgVersion"`
}

type provisionSingleRequest struct {
	ProjectID    string           `json:"projectId"`
	ClusterName  string           `json:"clusterName"`
	Template     string           `json:"template"`
	Runtime      provisionRuntime `json:"runtime"`
	ProviderType string           `json:"providerType"` // "docker" | "local"
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

type discoveryScanRequest struct {
	Host string `json:"host"`
	SSH  struct {
		User     string `json:"user"`
		Password string `json:"password"`
		Port     int    `json:"port"`
	} `json:"ssh"`
}

type discoveryInstance struct {
	Host       string `json:"host"`
	Port       int    `json:"port"`
	Version    string `json:"version,omitempty"`
	DataDir    string `json:"dataDir,omitempty"`
	Service    string `json:"service,omitempty"`
	Confidence string `json:"confidence,omitempty"`
}

type discoveryScanResponse struct {
	Success   bool                `json:"success"`
	Instances []discoveryInstance `json:"instances,omitempty"`
	Error     string              `json:"error,omitempty"`
}

type discoveryImportRequest struct {
	ProjectID   string            `json:"projectId"`
	ClusterID   string            `json:"clusterId"`
	Instance    discoveryInstance `json:"instance"`
	AutoConnect bool              `json:"autoConnect"`
	User        string            `json:"user,omitempty"`
	Password    string            `json:"password,omitempty"`
	Database    string            `json:"database,omitempty"`
}

type dsnValidateRequest struct {
	DSN string `json:"dsn"`
}

type dsnValidateResponse struct {
	Success       bool   `json:"success"`
	Reachable     bool   `json:"reachable"`
	Version       string `json:"version,omitempty"`
	NormalizedDSN string `json:"normalizedDsn,omitempty"`
	Error         string `json:"error,omitempty"`
}

type dsnImportRequest struct {
	ProjectID   string `json:"projectId"`
	ClusterID   string `json:"clusterId"`
	DSN         string `json:"dsn"`
	AutoConnect bool   `json:"autoConnect"`
}

type provisionTask struct {
	TaskID     string   `json:"taskId"`
	TaskType   string   `json:"taskType"`   // "provision.single" | "provision.physical" | "provision.logical" | "discovery.scan" | "discovery.import"
	Status     string   `json:"status"`     // "pending" | "running" | "success" | "failed"
	Progress   int      `json:"progress"`   // 0-100
	Message    string   `json:"message,omitempty"`
	Result     string   `json:"result,omitempty"`   // added: result summary
	Logs       string   `json:"logs,omitempty"`     // added: full logs
	ProjectID  string   `json:"projectId,omitempty"`
	ClusterID  string   `json:"clusterId,omitempty"`
	NodeIDs    []string `json:"nodeIds,omitempty"`  // added
	Error      string   `json:"error,omitempty"`    // added
	StartedAt  int64    `json:"startedAt,omitempty"`
	FinishedAt int64    `json:"finishedAt,omitempty"`
}

func (h *Handler) ServeProvisionSingle(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		h.writeError(w, r, 405, "POST required")
		return
	}
	var req provisionSingleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
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

	// Step 1: Create task (progress 5)
	h.setProvisionTask(provisionTask{
		TaskID:    taskID,
		Status:    "running",
		Progress:  5,
		Message:   "starting single-node provision",
		ProjectID: req.ProjectID,
		ClusterID: clusterID,
		StartedAt: time.Now().UnixMilli(),
	})

	// Step 2: Build InstanceSpec (ProviderType defaults to "docker")
	providerType := orDefaultStr(req.ProviderType, "docker")
	spec := provision.InstanceSpec{
		Name:      orDefaultStr(strings.TrimSpace(req.ClusterName), "单机集群"),
		PGVersion: orDefaultStr(req.Runtime.PGVersion, "16"),
		Port:      orDefaultInt(h.config.PGPort, 5432),
		DataDir:   "",
		Env:       nil,
	}

	// Step 3: Call provisionService.StartSingle (progress 10-70)
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
		// Step 4: On error, set task failed (no cleanup needed - instance not started)
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

	// Build cluster with actual host/port from InstanceInfo
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

	// Step 6: Save cluster to workspace (progress 70)
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
		// Cleanup instance on workspace save failure
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

	// Step 7: Try connect node (progress 90)
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
	if len(cluster.Nodes) > 0 {
		if h.tryConnectNode(cluster.Nodes[0]) == nil {
			autoConnected = cluster.Nodes[0].ID
		}
	}

	// Step 8: Set task success (progress 100)
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

	// Step 9: Return provisionResponse
	writeJSON(w, r, 200, provisionResponse{
		Success:             true,
		ProjectID:           req.ProjectID,
		ClusterID:           cluster.ID,
		NodeIDs:             []string{cluster.Nodes[0].ID},
		AutoConnectedNodeID: autoConnected,
		TaskID:              taskID,
	})
}

func (h *Handler) ServeProvisionPhysical(w http.ResponseWriter, r *http.Request) {
	var req ReplicaProvisionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeError(w, r, 400, "invalid JSON")
		return
	}
	req.Type = "physical"
	h.serveProvisionReplica(w, r, req)
}

func (h *Handler) ServeProvisionLogical(w http.ResponseWriter, r *http.Request) {
	var req ReplicaProvisionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeError(w, r, 400, "invalid JSON")
		return
	}
	req.Type = "logical"
	h.serveProvisionReplica(w, r, req)
}

func (h *Handler) serveProvisionReplica(w http.ResponseWriter, r *http.Request, req ReplicaProvisionRequest) {
	if r.Method != "POST" {
		h.writeError(w, r, 405, "POST required")
		return
	}

	// Validate type
	replType := strings.ToLower(strings.TrimSpace(req.Type))
	if replType != "physical" && replType != "logical" {
		h.writeError(w, r, 400, "type must be 'physical' or 'logical'")
		return
	}
	if strings.TrimSpace(req.ProjectID) == "" {
		h.writeError(w, r, 400, "projectId is required")
		return
	}

	// Determine roles based on type
	clusterType := replType
	roleA, roleB := "primary", "standby"
	name := "物理复制集群"
	if replType == "logical" {
		roleA, roleB = "publisher", "subscriber"
		name = "逻辑复制集群"
	}

	// IDs
	taskID := genID("task")
	clusterID := genID("cluster")
	primaryNodeID := genID("node")
	standbyNodeID := genID("node")

	// Step 1: Create task (progress 5)
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

	// Step 2: Build InstanceSpec for primary
	providerType := orDefaultStr(req.Runtime.Type, "docker")
	primaryPort := req.Runtime.PrimaryPort
	if primaryPort == 0 {
		primaryPort = orDefaultInt(h.config.PGPort, 5432)
	}
	spec := provision.InstanceSpec{
		Name:      orDefaultStr(strings.TrimSpace(req.ClusterName), name),
		PGVersion: orDefaultStr(req.Runtime.PGVersion, "16"),
		Port:      primaryPort,
		DataDir:   "",
		Env:       nil,
	}

	// Step 3: Start primary (progress 10-30)
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

	// Step 4: Wait for primary to be ready (progress 30-40)
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

	// Step 5: Get replication provider and start replica (progress 40-60)
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

	// Step 6: Build cluster and nodes
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

	// Step 7: Save cluster to workspace (progress 60-70)
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

	// Step 8: Try connect primary node (progress 70-90)
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

	// Step 9: Done (progress 100)
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

func (h *Handler) ServeDiscoveryHostScan(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		h.writeError(w, r, 405, "POST required")
		return
	}
	var req discoveryScanRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeError(w, r, 400, "invalid JSON")
		return
	}
	host := strings.TrimSpace(req.Host)
	if host == "" {
		h.writeError(w, r, 400, "host is required")
		return
	}

	ports := []int{5432, 5433}
	instances := make([]discoveryInstance, 0, len(ports))
	for _, p := range ports {
		if portOpen(host, p, 900*time.Millisecond) {
			instances = append(instances, discoveryInstance{
				Host:       host,
				Port:       p,
				Service:    "postgresql",
				Confidence: "medium",
			})
		}
	}
	writeJSON(w, r, 200, discoveryScanResponse{Success: true, Instances: instances})
}

func (h *Handler) ServeDiscoveryHostImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		h.writeError(w, r, 405, "POST required")
		return
	}
	var req discoveryImportRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeError(w, r, 400, "invalid JSON")
		return
	}
	if req.ProjectID == "" || req.ClusterID == "" {
		h.writeError(w, r, 400, "projectId and clusterId are required")
		return
	}
	if req.Instance.Host == "" || req.Instance.Port == 0 {
		h.writeError(w, r, 400, "instance host/port are required")
		return
	}

	node := workspaceNode{
		ID:          genID("node"),
		Name:        fmt.Sprintf("%s:%d", req.Instance.Host, req.Instance.Port),
		Host:        req.Instance.Host,
		Port:        req.Instance.Port,
		User:        orDefaultStr(req.User, h.config.PGUser),
		Password:    orDefaultStr(req.Password, h.config.PGPassword),
		Database:    orDefaultStr(req.Database, h.config.PGDatabase),
		ClusterType: "physical",
		Role:        "standby",
		Source:      "discovered",
		InstanceMeta: &workspaceInstanceMeta{
			Service: req.Instance.Service,
			DataDir: req.Instance.DataDir,
			Version: req.Instance.Version,
		},
		SSHHint: &workspaceSSHHint{
			Host: req.Instance.Host,
			Port: 22,
		},
	}

	if err := h.workspace.appendNode(req.ProjectID, req.ClusterID, node); err != nil {
		h.writeError(w, r, 400, err.Error())
		return
	}
	connected := false
	if req.AutoConnect && h.tryConnectNode(node) == nil {
		connected = true
	}
	writeJSON(w, r, 200, map[string]any{"success": true, "nodeId": node.ID, "connected": connected})
}

func (h *Handler) ServeDiscoveryDSNValidate(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		h.writeError(w, r, 405, "POST required")
		return
	}
	var req dsnValidateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeError(w, r, 400, "invalid JSON")
		return
	}
	host, port, user, pass, db, err := parseDSN(req.DSN)
	if err != nil {
		writeJSON(w, r, 200, dsnValidateResponse{Success: false, Reachable: false, Error: err.Error()})
		return
	}
	client := &pgClientProxy{}
	version, err := client.connectAndVersion(host, port, user, pass, db)
	if err != nil {
		writeJSON(w, r, 200, dsnValidateResponse{Success: false, Reachable: false, Error: err.Error()})
		return
	}
	writeJSON(w, r, 200, dsnValidateResponse{Success: true, Reachable: true, Version: version, NormalizedDSN: req.DSN})
}

func (h *Handler) ServeDiscoveryDSNImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		h.writeError(w, r, 405, "POST required")
		return
	}
	var req dsnImportRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeError(w, r, 400, "invalid JSON")
		return
	}
	host, port, user, pass, db, err := parseDSN(req.DSN)
	if err != nil {
		h.writeError(w, r, 400, err.Error())
		return
	}
	node := workspaceNode{
		ID:          genID("node"),
		Name:        fmt.Sprintf("%s:%d", host, port),
		Host:        host,
		Port:        port,
		User:        user,
		Password:    pass,
		Database:    db,
		ClusterType: "physical",
		Role:        "standby",
		Source:      "dsn",
		DSN:         req.DSN,
	}
	if err := h.workspace.appendNode(req.ProjectID, req.ClusterID, node); err != nil {
		h.writeError(w, r, 400, err.Error())
		return
	}
	connected := false
	if req.AutoConnect && h.tryConnectNode(node) == nil {
		connected = true
	}
	writeJSON(w, r, 200, map[string]any{"success": true, "nodeId": node.ID, "connected": connected})
}

func (h *Handler) tryConnectNode(node workspaceNode) error {
	client := &pg.Client{}
	if err := client.Connect(node.Host, node.Port, node.User, node.Password, node.Database); err != nil {
		return err
	}
	h.connMgr.Register(node.ID, connection.Config{
		Host:     node.Host,
		Port:     node.Port,
		User:     node.User,
		Password: node.Password,
		Database: node.Database,
	})
	return h.connMgr.Activate(node.ID)
}

func parseDSN(dsn string) (host string, port int, user, pass, db string, err error) {
	u, err := url.Parse(strings.TrimSpace(dsn))
	if err != nil {
		return "", 0, "", "", "", fmt.Errorf("invalid dsn: %w", err)
	}
	if u.Scheme != "postgres" && u.Scheme != "postgresql" {
		return "", 0, "", "", "", fmt.Errorf("invalid dsn scheme")
	}
	host = u.Hostname()
	if host == "" {
		return "", 0, "", "", "", fmt.Errorf("dsn host is required")
	}
	port = 5432
	if p := u.Port(); p != "" {
		v, e := strconv.Atoi(p)
		if e != nil {
			return "", 0, "", "", "", fmt.Errorf("invalid dsn port")
		}
		port = v
	}
	if u.User != nil {
		user = u.User.Username()
		pass, _ = u.User.Password()
	}
	db = strings.TrimPrefix(u.Path, "/")
	if db == "" {
		db = "postgres"
	}
	return host, port, user, pass, db, nil
}

func portOpen(host string, port int, timeout time.Duration) bool {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", host, port), timeout)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

func waitForPostgres(ctx context.Context, host string, port int) error {
	addr := fmt.Sprintf("%s:%d", host, port)
	for i := 0; i < 30; i++ {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		conn, err := net.DialTimeout("tcp", addr, time.Second)
		if err == nil {
			conn.Close()
			return nil
		}
		time.Sleep(time.Second)
	}
	return fmt.Errorf("postgres not ready at %s", addr)
}

func genID(prefix string) string {
	return fmt.Sprintf("%s-%d", prefix, time.Now().UnixNano())
}

type pgClientProxy struct{}

func (h *Handler) setProvisionTask(t provisionTask) {
	h.taskMu.Lock()
	defer h.taskMu.Unlock()
	if old, ok := h.tasks[t.TaskID]; ok {
		if t.StartedAt == 0 {
			t.StartedAt = old.StartedAt
		}
		if t.ProjectID == "" {
			t.ProjectID = old.ProjectID
		}
		if t.ClusterID == "" {
			t.ClusterID = old.ClusterID
		}
	}
	if t.StartedAt == 0 {
		t.StartedAt = time.Now().UnixMilli()
	}
	h.tasks[t.TaskID] = t
	h.persistProvisionTasksLocked()
}

func (h *Handler) getProvisionTask(id string) (provisionTask, bool) {
	h.taskMu.Lock()
	defer h.taskMu.Unlock()
	t, ok := h.tasks[id]
	return t, ok
}

func (h *Handler) listProvisionTasks(limit int, statusFilter string) ([]provisionTask, map[string]int) {
	h.taskMu.Lock()
	defer h.taskMu.Unlock()
	items := make([]provisionTask, 0, len(h.tasks))
	summary := map[string]int{
		"all":     0,
		"running": 0,
		"success": 0,
		"failed":  0,
	}
	for _, t := range h.tasks {
		summary["all"]++
		if _, ok := summary[t.Status]; ok {
			summary[t.Status]++
		}
		if statusFilter != "" && statusFilter != "all" && t.Status != statusFilter {
			continue
		}
		items = append(items, t)
	}
	sort.Slice(items, func(i, j int) bool {
		ti := items[i].StartedAt
		tj := items[j].StartedAt
		if ti == tj {
			return items[i].TaskID > items[j].TaskID
		}
		return ti > tj
	})
	if limit > 0 && len(items) > limit {
		items = items[:limit]
	}
	return items, summary
}

func (h *Handler) loadProvisionTasks() {
	h.taskMu.Lock()
	defer h.taskMu.Unlock()
	b, err := os.ReadFile(h.taskPath)
	if err != nil {
		return
	}
	if len(strings.TrimSpace(string(b))) == 0 {
		return
	}
	var tasks map[string]provisionTask
	if err := json.Unmarshal(b, &tasks); err != nil {
		return
	}
	h.tasks = tasks
}

func (h *Handler) persistProvisionTasksLocked() {
	if err := os.MkdirAll(filepath.Dir(h.taskPath), 0o755); err != nil {
		return
	}
	b, err := json.MarshalIndent(h.tasks, "", "  ")
	if err != nil {
		return
	}
	tmp := h.taskPath + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, h.taskPath)
}

func (p *pgClientProxy) connectAndVersion(host string, port int, user, password, db string) (string, error) {
	c := &pg.Client{}
	if err := c.Connect(host, port, user, password, db); err != nil {
		return "", err
	}
	defer c.Close()
	return c.GetVersion()
}
