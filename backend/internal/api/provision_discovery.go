package api

import (
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
)

type provisionRuntime struct {
	Type      string `json:"type"`
	PGVersion string `json:"pgVersion"`
}

type provisionSingleRequest struct {
	ProjectID   string           `json:"projectId"`
	ClusterName string           `json:"clusterName"`
	Template    string           `json:"template"`
	Runtime     provisionRuntime `json:"runtime"`
}

type provisionReplicaRequest struct {
	ProjectID   string           `json:"projectId"`
	ClusterName string           `json:"clusterName"`
	Runtime     provisionRuntime `json:"runtime"`
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
	TaskID     string `json:"taskId"`
	Status     string `json:"status"`
	Progress   int    `json:"progress"`
	Message    string `json:"message,omitempty"`
	ProjectID  string `json:"projectId,omitempty"`
	ClusterID  string `json:"clusterId,omitempty"`
	StartedAt  int64  `json:"startedAt,omitempty"`
	FinishedAt int64  `json:"finishedAt,omitempty"`
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

	cluster := workspaceCluster{
		ID:              genID("cluster"),
		Name:            orDefaultStr(strings.TrimSpace(req.ClusterName), "单机集群"),
		ReplicationType: "physical",
		ProvisionMode:   "single",
		Runtime: &workspaceRuntime{
			Type:      orDefaultStr(req.Runtime.Type, "local"),
			PGVersion: req.Runtime.PGVersion,
		},
		AlertThresholdSec: 30,
		Nodes: []workspaceNode{
			{
				ID:          genID("node"),
				Name:        "node-1",
				Host:        orDefaultStr(h.config.PGHost, "127.0.0.1"),
				Port:        orDefaultInt(h.config.PGPort, 5432),
				User:        orDefaultStr(h.config.PGUser, "postgres"),
				Password:    h.config.PGPassword,
				Database:    orDefaultStr(h.config.PGDatabase, "postgres"),
				ClusterType: "physical",
				Role:        "primary",
				Source:      "provisioned",
			},
		},
	}
	taskID := genID("task")
	h.setProvisionTask(provisionTask{
		TaskID:    taskID,
		Status:    "running",
		Progress:  20,
		Message:   "creating single-node cluster",
		ProjectID: req.ProjectID,
		ClusterID: cluster.ID,
		StartedAt: time.Now().UnixMilli(),
	})

	if err := h.workspace.appendCluster(req.ProjectID, cluster); err != nil {
		h.setProvisionTask(provisionTask{
			TaskID:     taskID,
			Status:     "failed",
			Progress:   100,
			Message:    err.Error(),
			ProjectID:  req.ProjectID,
			ClusterID:  cluster.ID,
			StartedAt:  time.Now().UnixMilli(),
			FinishedAt: time.Now().UnixMilli(),
		})
		h.writeError(w, r, 400, err.Error())
		return
	}
	h.setProvisionTask(provisionTask{
		TaskID:    taskID,
		Status:    "running",
		Progress:  80,
		Message:   "cluster metadata created, testing connection",
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

	writeJSON(w, r, 200, provisionResponse{
		Success:             true,
		ProjectID:           req.ProjectID,
		ClusterID:           cluster.ID,
		NodeIDs:             []string{cluster.Nodes[0].ID},
		AutoConnectedNodeID: autoConnected,
		TaskID:              taskID,
	})
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
}

func (h *Handler) ServeProvisionPhysical(w http.ResponseWriter, r *http.Request) {
	h.serveProvisionReplica(w, r, "physical")
}

func (h *Handler) ServeProvisionLogical(w http.ResponseWriter, r *http.Request) {
	h.serveProvisionReplica(w, r, "logical")
}

func (h *Handler) serveProvisionReplica(w http.ResponseWriter, r *http.Request, mode string) {
	if r.Method != "POST" {
		h.writeError(w, r, 405, "POST required")
		return
	}
	var req provisionReplicaRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		h.writeError(w, r, 400, "invalid JSON")
		return
	}
	if strings.TrimSpace(req.ProjectID) == "" {
		h.writeError(w, r, 400, "projectId is required")
		return
	}

	clusterType := "physical"
	roleA, roleB := "primary", "standby"
	name := "物理复制集群"
	if mode == "logical" {
		clusterType = "logical"
		roleA, roleB = "publisher", "subscriber"
		name = "逻辑复制集群"
	}

	basePort := orDefaultInt(h.config.PGPort, 5432)
	taskID := genID("task")
	cluster := workspaceCluster{
		ID:              genID("cluster"),
		Name:            orDefaultStr(strings.TrimSpace(req.ClusterName), name),
		ReplicationType: clusterType,
		ProvisionMode:   mode,
		ProvisionTaskID: taskID,
		Runtime: &workspaceRuntime{
			Type:      orDefaultStr(req.Runtime.Type, "local"),
			PGVersion: req.Runtime.PGVersion,
		},
		AlertThresholdSec: 30,
		Nodes: []workspaceNode{
			{
				ID:          genID("node"),
				Name:        roleA + "-1",
				Host:        orDefaultStr(h.config.PGHost, "127.0.0.1"),
				Port:        basePort,
				User:        orDefaultStr(h.config.PGUser, "postgres"),
				Password:    h.config.PGPassword,
				Database:    orDefaultStr(h.config.PGDatabase, "postgres"),
				ClusterType: clusterType,
				Role:        roleA,
				Source:      "provisioned",
			},
			{
				ID:          genID("node"),
				Name:        roleB + "-1",
				Host:        orDefaultStr(h.config.PGHost, "127.0.0.1"),
				Port:        basePort + 1,
				User:        orDefaultStr(h.config.PGUser, "postgres"),
				Password:    h.config.PGPassword,
				Database:    orDefaultStr(h.config.PGDatabase, "postgres"),
				ClusterType: clusterType,
				Role:        roleB,
				Source:      "provisioned",
			},
		},
	}
	h.setProvisionTask(provisionTask{
		TaskID:    taskID,
		Status:    "running",
		Progress:  20,
		Message:   "creating replicated cluster",
		ProjectID: req.ProjectID,
		ClusterID: cluster.ID,
		StartedAt: time.Now().UnixMilli(),
	})

	if err := h.workspace.appendCluster(req.ProjectID, cluster); err != nil {
		h.setProvisionTask(provisionTask{
			TaskID:     taskID,
			Status:     "failed",
			Progress:   100,
			Message:    err.Error(),
			ProjectID:  req.ProjectID,
			ClusterID:  cluster.ID,
			StartedAt:  time.Now().UnixMilli(),
			FinishedAt: time.Now().UnixMilli(),
		})
		h.writeError(w, r, 400, err.Error())
		return
	}
	h.setProvisionTask(provisionTask{
		TaskID:    taskID,
		Status:    "running",
		Progress:  80,
		Message:   "cluster metadata created, testing primary connection",
		ProjectID: req.ProjectID,
		ClusterID: cluster.ID,
		StartedAt: time.Now().UnixMilli(),
	})

	autoConnected := ""
	if len(cluster.Nodes) > 0 && h.tryConnectNode(cluster.Nodes[0]) == nil {
		autoConnected = cluster.Nodes[0].ID
	}

	writeJSON(w, r, 200, provisionResponse{
		Success:             true,
		ProjectID:           req.ProjectID,
		ClusterID:           cluster.ID,
		NodeIDs:             []string{cluster.Nodes[0].ID, cluster.Nodes[1].ID},
		AutoConnectedNodeID: autoConnected,
		TaskID:              cluster.ProvisionTaskID,
	})
	h.setProvisionTask(provisionTask{
		TaskID:     taskID,
		Status:     "success",
		Progress:   100,
		Message:    "replicated cluster ready",
		ProjectID:  req.ProjectID,
		ClusterID:  cluster.ID,
		StartedAt:  time.Now().UnixMilli(),
		FinishedAt: time.Now().UnixMilli(),
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
