package api

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"pg-visualizer-backend/internal/api/openapi"
	"pg-visualizer-backend/internal/auditlog"
	"pg-visualizer-backend/internal/connection"
	"pg-visualizer-backend/internal/config"
	"pg-visualizer-backend/internal/middleware"
	"pg-visualizer-backend/internal/pg"
	"pg-visualizer-backend/internal/provision"
	"pg-visualizer-backend/internal/telemetrystore"
	"pg-visualizer-backend/internal/ws"
	"pg-visualizer-backend/pkg/clog"
	"pg-visualizer-backend/pkg/wal"
)

// Handler holds API dependencies
type Handler struct {
	config           *config.Config
	hub              *ws.Hub
	connMgr          *connection.Manager
	workspace        *workspaceStore
	provisionService *provision.Service
	taskMu           sync.Mutex
	tasks            map[string]provisionTask
	taskPath         string
	telemetry        *telemetrystore.Store
}

// NewHandler creates a new API handler. If cfg.WorkspaceEncryptionKey is
// set but malformed, we log a warning and fall back to plain text mode
// (the store reads and writes without encryption). Fail-closed would be
// safer but would block dev environments with a typo.
func NewHandler(cfg *config.Config, hub *ws.Hub, connMgr *connection.Manager) *Handler {
	key, err := ResolveEncryptionKey(cfg.WorkspaceEncryptionKey)
	if err != nil {
		slog.Warn("workspace encryption key is malformed; falling back to plain text",
			slog.String("env", "WORKSPACE_ENCRYPTION_KEY"),
			slog.String("err", err.Error()))
	}
h := &Handler{
		config:           cfg,
		hub:              hub,
		connMgr:          connMgr,
		workspace:        newWorkspaceStore(defaultWorkspaceFilePath(), key),
		provisionService: provision.NewService(),
		tasks:            make(map[string]provisionTask),
		taskPath:         defaultProvisionTaskFilePath(),
	}
	h.provisionService.RegisterProvider(&provision.DockerProvider{})
	h.provisionService.RegisterProvider(&provision.LocalProvider{})
	h.provisionService.RegisterReplicationProvider(provision.NewDockerReplicationProvider("data"))
	h.loadProvisionTasks()
	h.telemetry = telemetrystore.NewWithOptions(telemetrystore.Options{
		Path:      cfg.TelemetryStorePath,
		Retention: cfg.TelemetryRetention,
		MaxEvents: cfg.TelemetryMaxEvents,
	})
	return h
}

func defaultWorkspaceFilePath() string {
	return filepath.Join("data", "workspace_projects.json")
}

func defaultProvisionTaskFilePath() string {
	return filepath.Join("data", "provision_tasks.json")
}

// SetConnMgr sets the connection manager
// SetAuditLog installs the audit logger. The handler keeps no
	// reference after the call returns so callers are free to swap
	// loggers between tests.
	func (h *Handler) SetAuditLog(l *auditlog.Logger) {
		auditlog.SetDefault(l)
	}

	func (h *Handler) SetConnMgr(mgr *connection.Manager) {
	h.connMgr = mgr
}

// ─── Error response ─────────────────────────────────────────────────────────

// ErrorResponse is the canonical error shape for all API responses.
type ErrorResponse struct {
	Success   bool   `json:"success"`
	Error     string `json:"error"`
	RequestID string `json:"request_id,omitempty"`
}

func (h *Handler) writeError(w http.ResponseWriter, r *http.Request, status int, errMsg string) {
	reqID := middleware.RequestIDFromContext(r.Context())
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(ErrorResponse{
		Success:   false,
		Error:     errMsg,
		RequestID: reqID,
	})
}

func writeJSON(w http.ResponseWriter, r *http.Request, status int, payload interface{}) {
	reqID := middleware.RequestIDFromContext(r.Context())
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if reqID != "" {
		w.Header().Set("X-Request-ID", reqID)
	}
	json.NewEncoder(w).Encode(payload)
}

// ─── Health endpoints ────────────────────────────────────────────────────────

type healthResponse struct {
	Status      string `json:"status"`
	PGConnected bool   `json:"pg_connected"`
}

// ServeHealth handles GET /health
func (h *Handler) ServeHealth(w http.ResponseWriter, r *http.Request) {
	_, client := h.connMgr.GetActive()
	pgOK := false
	if client != nil {
		if err := client.Ping(); err == nil {
			pgOK = true
		}
	}
	writeJSON(w, r, http.StatusOK, healthResponse{
		Status:      "ok",
		PGConnected: pgOK,
	})
}

// ServeReadyz handles GET /readyz — readiness probe (all deps up).
//
// We check the things the backend cannot serve traffic without:
//   1. data/ directory is writable (workspace JSON, provision tasks)
//   2. workspace_projects.json is parseable (not corrupted)
//
// We do NOT require an active user-connected PG here — that is a property
// of the user's session, not the service. If COLLECTOR_WS_URL is set we
// also probe it, but a collector outage is "degraded" not "not_ready":
// the rest of the API (workspace CRUD, provision, top-level reads) still
// functions, just without real-time telemetry.
func (h *Handler) ServeReadyz(w http.ResponseWriter, r *http.Request) {
	// The "data dir" for service-level readiness is the parent of the
	// workspace file — that's where we need write access for any CRUD.
	dataDir := ""
	if h.workspace != nil {
		dataDir = filepath.Dir(h.workspace.path)
	}
	dataDirOK := dataDir != "" && dirExists(dataDir) && dirWritable(dataDir)

	workspaceOK := false
	if dataDirOK && h.workspace != nil {
		// Probe read+parse without holding the lock; failures are not fatal
		// because the workspace file may legitimately not exist on first boot.
		if _, _, err := h.workspace.readSnapshot(); err == nil {
			workspaceOK = true
		} else {
			workspaceOK = !fileExists(h.workspace.path)
		}
	}

	collectorStatus := "skipped"
	collectorOK := true // default to OK when not configured
	if h.config != nil && h.config.CollectorWSURL != "" {
		collectorOK, collectorStatus = probeWS(h.config.CollectorWSURL, 2*time.Second)
	}

	ready := dataDirOK && workspaceOK && collectorOK
	resp := map[string]interface{}{
		"data_dir":  dataDir,
		"workspace": statusString(workspaceOK),
		"collector": collectorStatus,
	}
	if ready {
		resp["status"] = "ready"
		writeJSON(w, r, http.StatusOK, resp)
		return
	}

	// 503 means "remove from load balancer pool"; we want a different body
	// if only the collector is down so the operator can tell which dep is bad.
	if !dataDirOK || !workspaceOK {
		resp["status"] = "not_ready"
		writeJSON(w, r, http.StatusServiceUnavailable, resp)
		return
	}
	resp["status"] = "degraded"
	writeJSON(w, r, http.StatusOK, resp)
}

func statusString(ok bool) string {
	if ok {
		return "ok"
	}
	return "fail"
}

// dirWritable reports whether the current process can create files in dir.
func dirWritable(dir string) bool {
	f, err := os.CreateTemp(dir, ".readyz-*")
	if err != nil {
		return false
	}
	_ = f.Close()
	_ = os.Remove(f.Name())
	return true
}

// fileExists is a tiny helper; avoids pulling in os.Stat boilerplate everywhere.
func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// probeWS opens a WebSocket dial with timeout and immediately closes it. Used
// for /readyz checks of the collector. Returns (reachable, status-string).
func probeWS(url string, timeout time.Duration) (bool, string) {
	dialer := websocket.Dialer{HandshakeTimeout: timeout}
	conn, _, err := dialer.Dial(url, nil)
	if err != nil {
		return false, "unreachable"
	}
	_ = conn.Close()
	return true, "ok"
}

// ServeLivez handles GET /livez — liveness probe (process alive)
func (h *Handler) ServeLivez(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, r, http.StatusOK, map[string]string{"status": "alive"})
}

// ─── Connect ─────────────────────────────────────────────────────────────────

type connectRequest struct {
	Host     *string `json:"host"`
	Port     *int    `json:"port"`
	User     *string `json:"user"`
	Password *string `json:"password"`
	Database *string `json:"database"`
}

type connectResponse struct {
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
	Version string `json:"version,omitempty"`
	DataDir string `json:"data_dir,omitempty"`
}

func (h *Handler) ServeConnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		h.writeError(w, r, http.StatusMethodNotAllowed, "POST required")
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64*1024))
	if err != nil {
		h.writeError(w, r, http.StatusBadRequest, "failed to read body")
		return
	}
	defer r.Body.Close()

	var req connectRequest
	if err := json.Unmarshal(body, &req); err != nil {
		h.writeError(w, r, http.StatusBadRequest, "invalid JSON")
		return
	}

	hostVal := h.config.PGHost
	if req.Host != nil {
		if *req.Host == "" {
			h.writeError(w, r, http.StatusBadRequest, "host is required")
			return
		}
		hostVal = *req.Host
	}
	portVal := h.config.PGPort
	if req.Port != nil {
		portVal = *req.Port
	}
	userVal := h.config.PGUser
	if req.User != nil {
		userVal = *req.User
	}
	passwordVal := h.config.PGPassword
	if req.Password != nil {
		passwordVal = *req.Password
	}
	dbVal := h.config.PGDatabase
	if req.Database != nil {
		dbVal = *req.Database
	}

	client := &pg.Client{}
	if err := client.Connect(hostVal, portVal, userVal, passwordVal, dbVal); err != nil {
		auditlog.Log(r.Context(), auditlog.ActionConnect, auditlog.ActorFromRequest(r), r.Method, r.URL.Path, "failure", map[string]any{
			"host": hostVal, "port": portVal, "user": userVal, "database": dbVal,
			"reason": "connect_failed",
		})
		h.writeError(w, r, http.StatusBadGateway, err.Error())
		return
	}

	h.connMgr.Register("__direct__", connection.Config{
		Host:     hostVal,
		Port:     portVal,
		User:     userVal,
		Password: passwordVal,
		Database: dbVal,
	})
	h.connMgr.Activate("__direct__")

	version, _ := client.GetVersion()
	dataDir, _ := client.GetPGDataDir()

	auditlog.Log(r.Context(), auditlog.ActionConnect, auditlog.ActorFromRequest(r), r.Method, r.URL.Path, "success", map[string]any{
		"host": hostVal, "port": portVal, "user": userVal, "database": dbVal, "version": version,
	})
	slog.Info("PG connected", "host", hostVal, "port", portVal, "db", dbVal, "version", version)
	writeJSON(w, r, http.StatusOK, connectResponse{
		Success: true,
		Version: version,
		DataDir: dataDir,
	})
}

// ─── Execute ─────────────────────────────────────────────────────────────────

type executeRequest struct {
	SQL string `json:"sql"`
}

type executeResponse struct {
	Success bool              `json:"success"`
	Result  *pg.ExecuteResult `json:"result,omitempty"`
	Error   string            `json:"error,omitempty"`
}

type workspaceProjectsResponse struct {
	Success       bool               `json:"success"`
	SchemaVersion int                `json:"schemaVersion"`
	Projects      []workspaceProject `json:"projects"`
	Error         string             `json:"error,omitempty"`
}

type workspaceProjectRequest struct {
	Project workspaceProject `json:"project"`
}

type workspaceBulkRequest struct {
	Projects []workspaceProject `json:"projects"`
}

type clusterNodeRequest struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Host        string `json:"host"`
	Port        int    `json:"port"`
	User        string `json:"user"`
	Password    string `json:"password"`
	Database    string `json:"database"`
	ClusterType string `json:"cluster_type"` // physical | logical
	Role        string `json:"role"`         // primary/standby/publisher/subscriber
}

type clusterOverviewRequest struct {
	Nodes []clusterNodeRequest `json:"nodes"`
}

type clusterOverviewResponse struct {
	Success   bool                   `json:"success"`
	Timestamp int64                  `json:"timestamp"`
	Nodes     []clusterNodeStatus    `json:"nodes"`
	Summary   clusterOverviewSummary `json:"summary"`
	Error     string                 `json:"error,omitempty"`
}

type clusterOverviewSummary struct {
	TotalNodes     int `json:"total_nodes"`
	ConnectedNodes int `json:"connected_nodes"`
	PhysicalNodes  int `json:"physical_nodes"`
	LogicalNodes   int `json:"logical_nodes"`
}

type replicationChannel struct {
	Name      string `json:"name"`
	State     string `json:"state"`
	SyncState string `json:"sync_state"`
	SentLSN   string `json:"sent_lsn,omitempty"`
	WriteLSN  string `json:"write_lsn,omitempty"`
	FlushLSN  string `json:"flush_lsn,omitempty"`
	ReplayLSN string `json:"replay_lsn,omitempty"`
	LagBytes  int64  `json:"lag_bytes,omitempty"`
	WriteLag  string `json:"write_lag,omitempty"`
	FlushLag  string `json:"flush_lag,omitempty"`
	ReplayLag string `json:"replay_lag,omitempty"`
}

type logicalSubscription struct {
	Name          string `json:"name"`
	Enabled       bool   `json:"enabled"`
	WorkerType    string `json:"worker_type,omitempty"`
	ReceivedLSN   string `json:"received_lsn,omitempty"`
	LatestEndLSN  string `json:"latest_end_lsn,omitempty"`
	LatestEndTime string `json:"latest_end_time,omitempty"`
}

type clusterNodeStatus struct {
	ID                  string                `json:"id"`
	Name                string                `json:"name"`
	Host                string                `json:"host"`
	Port                int                   `json:"port"`
	Database            string                `json:"database"`
	ClusterType         string                `json:"cluster_type"`
	Role                string                `json:"role"`
	Connected           bool                  `json:"connected"`
	Error               string                `json:"error,omitempty"`
	Version             string                `json:"version,omitempty"`
	InRecovery          bool                  `json:"in_recovery"`
	CurrentLSN          string                `json:"current_lsn,omitempty"`
	ReplayLSN           string                `json:"replay_lsn,omitempty"`
	WalReceiverStatus   string                `json:"wal_receiver_status,omitempty"`
	PhysicalReplication []replicationChannel  `json:"physical_replication,omitempty"`
	LogicalSlots        int                   `json:"logical_slots"`
	Publications        int                   `json:"publications"`
	Subscriptions       []logicalSubscription `json:"subscriptions,omitempty"`
}

func (h *Handler) ServeExecute(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		h.writeError(w, r, http.StatusMethodNotAllowed, "POST required")
		return
	}
	_, client := h.connMgr.GetActive()
	if client == nil {
		h.writeError(w, r, http.StatusServiceUnavailable, "not connected to PostgreSQL")
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64*1024))
	if err != nil {
		h.writeError(w, r, http.StatusBadRequest, "failed to read body")
		return
	}
	defer r.Body.Close()

	var req executeRequest
	if err := json.Unmarshal(body, &req); err != nil {
		h.writeError(w, r, http.StatusBadRequest, "invalid JSON")
		return
	}
	if req.SQL == "" {
		h.writeError(w, r, http.StatusBadRequest, "sql field is required")
		return
	}

	result, err := client.Execute(req.SQL)
	if err != nil {
		auditlog.Log(r.Context(), auditlog.ActionExecute, auditlog.ActorFromRequest(r), r.Method, r.URL.Path, "failure", map[string]any{
			"sql_truncated": truncate(req.SQL, 200),
			"reason":        "execute_failed",
		})
		h.writeError(w, r, http.StatusBadRequest, err.Error())
		return
	}

	auditlog.Log(r.Context(), auditlog.ActionExecute, auditlog.ActorFromRequest(r), r.Method, r.URL.Path, "success", map[string]any{
		"sql_truncated": truncate(req.SQL, 200),
		"row_count":     len(result.Rows),
	})

	writeJSON(w, r, http.StatusOK, executeResponse{
		Success: result.Error == "",
		Result:  result,
		Error:   result.Error,
	})
}

func (h *Handler) ServeWorkspaceProjects(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		projects, schemaVersion, err := h.workspace.readSnapshot()
		if err != nil {
			h.writeError(w, r, http.StatusInternalServerError, "failed to load workspace: "+err.Error())
			return
		}
		writeJSON(w, r, http.StatusOK, workspaceProjectsResponse{
			Success:       true,
			SchemaVersion: schemaVersion,
			Projects:      projects,
		})
		return
	case http.MethodPost:
		var req workspaceProjectRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024*1024)).Decode(&req); err != nil {
			h.writeError(w, r, http.StatusBadRequest, "invalid JSON")
			return
		}
		if err := h.workspace.upsert(req.Project); err != nil {
			auditlog.Log(r.Context(), auditlog.ActionWorkspaceCreate, auditlog.ActorFromRequest(r), r.Method, r.URL.Path, "failure", map[string]any{
				"project_id": req.Project.ID, "reason": "upsert_failed",
			})
			h.writeError(w, r, http.StatusBadRequest, err.Error())
			return
		}
		auditlog.Log(r.Context(), auditlog.ActionWorkspaceCreate, auditlog.ActorFromRequest(r), r.Method, r.URL.Path, "success", map[string]any{
			"project_id": req.Project.ID, "project_name": req.Project.Name,
		})
		writeJSON(w, r, http.StatusOK, map[string]any{"success": true})
		return
	case http.MethodPut:
		var req workspaceBulkRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4*1024*1024)).Decode(&req); err != nil {
			h.writeError(w, r, http.StatusBadRequest, "invalid JSON")
			return
		}
		if req.Projects == nil {
			req.Projects = []workspaceProject{}
		}
		if err := h.workspace.writeAll(req.Projects); err != nil {
			auditlog.Log(r.Context(), auditlog.ActionWorkspaceUpdate, auditlog.ActorFromRequest(r), r.Method, r.URL.Path, "failure", map[string]any{
				"count": len(req.Projects), "reason": "write_failed",
			})
			h.writeError(w, r, http.StatusInternalServerError, "failed to save workspace: "+err.Error())
			return
		}
		auditlog.Log(r.Context(), auditlog.ActionWorkspaceUpdate, auditlog.ActorFromRequest(r), r.Method, r.URL.Path, "success", map[string]any{
			"count": len(req.Projects),
		})
		writeJSON(w, r, http.StatusOK, map[string]any{"success": true, "count": len(req.Projects)})
		return
	default:
		h.writeError(w, r, http.StatusMethodNotAllowed, "GET/POST/PUT required")
	}
}

func (h *Handler) ServeWorkspaceProjectByID(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete && r.Method != http.MethodPut {
		h.writeError(w, r, http.StatusMethodNotAllowed, "PUT/DELETE required")
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/workspace/projects/")
	id = strings.TrimSpace(id)
	if id == "" {
		h.writeError(w, r, http.StatusBadRequest, "project id is required")
		return
	}

	if r.Method == http.MethodDelete {
		if err := h.workspace.deleteByID(id); err != nil {
			auditlog.Log(r.Context(), auditlog.ActionWorkspaceDelete, auditlog.ActorFromRequest(r), r.Method, r.URL.Path, "failure", map[string]any{
				"project_id": id, "reason": "delete_failed",
			})
			h.writeError(w, r, http.StatusInternalServerError, "failed to delete project: "+err.Error())
			return
		}
		auditlog.Log(r.Context(), auditlog.ActionWorkspaceDelete, auditlog.ActorFromRequest(r), r.Method, r.URL.Path, "success", map[string]any{
			"project_id": id,
		})
		writeJSON(w, r, http.StatusOK, map[string]any{"success": true})
		return
	}

	var req workspaceProjectRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024*1024)).Decode(&req); err != nil {
		h.writeError(w, r, http.StatusBadRequest, "invalid JSON")
		return
	}
	req.Project.ID = id
	if err := h.workspace.upsert(req.Project); err != nil {
		auditlog.Log(r.Context(), auditlog.ActionWorkspaceUpdate, auditlog.ActorFromRequest(r), r.Method, r.URL.Path, "failure", map[string]any{
			"project_id": id, "reason": "upsert_failed",
		})
		h.writeError(w, r, http.StatusBadRequest, err.Error())
		return
	}
	auditlog.Log(r.Context(), auditlog.ActionWorkspaceUpdate, auditlog.ActorFromRequest(r), r.Method, r.URL.Path, "success", map[string]any{
		"project_id": id,
	})
	writeJSON(w, r, http.StatusOK, map[string]any{"success": true})
}

// ServeClusterOverview handles GET /api/cluster/{clusterId}/overview — inspects all nodes in a cluster from the workspace store.
func (h *Handler) ServeClusterOverview(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		h.writeError(w, r, http.StatusMethodNotAllowed, "GET required")
		return
	}
	clusterID := extractClusterIDFromPath(r.URL.Path)
	if clusterID == "" {
		h.writeError(w, r, http.StatusBadRequest, "cluster id required")
		return
	}

	projects, _, err := h.workspace.readSnapshot()
	if err != nil {
		h.writeError(w, r, http.StatusInternalServerError, err.Error())
		return
	}

	var cluster *workspaceCluster
	for pi := range projects {
		for ci := range projects[pi].Clusters {
			if projects[pi].Clusters[ci].ID == clusterID {
				cluster = &projects[pi].Clusters[ci]
				break
			}
		}
	}
	if cluster == nil {
		h.writeError(w, r, http.StatusNotFound, "cluster not found")
		return
	}

	resp := clusterOverviewResponse{
		Success:   true,
		Timestamp: time.Now().Unix(),
		Nodes:     make([]clusterNodeStatus, 0, len(cluster.Nodes)),
	}

	for i, node := range cluster.Nodes {
		status := h.inspectNodeByID(node.ID)
		if status.ID == "" {
			status.ID = fmt.Sprintf("node-%d", i+1)
		}
		resp.Nodes = append(resp.Nodes, status)
		resp.Summary.TotalNodes++
		if status.Connected {
			resp.Summary.ConnectedNodes++
		}
		if strings.EqualFold(status.ClusterType, "physical") {
			resp.Summary.PhysicalNodes++
		}
		if strings.EqualFold(status.ClusterType, "logical") {
			resp.Summary.LogicalNodes++
		}
	}

	writeJSON(w, r, http.StatusOK, resp)
}

// ServeClusterOverviewLegacy handles POST /api/cluster/overview — inspects nodes passed in request body (legacy interface).
func (h *Handler) ServeClusterOverviewLegacy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		h.writeError(w, r, http.StatusMethodNotAllowed, "POST required")
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 512*1024))
	if err != nil {
		h.writeError(w, r, http.StatusBadRequest, "failed to read body")
		return
	}
	defer r.Body.Close()

	var req clusterOverviewRequest
	if err := json.Unmarshal(body, &req); err != nil {
		h.writeError(w, r, http.StatusBadRequest, "invalid JSON")
		return
	}
	if len(req.Nodes) == 0 {
		h.writeError(w, r, http.StatusBadRequest, "nodes is required and must contain at least one node")
		return
	}

	resp := clusterOverviewResponse{
		Success:   true,
		Timestamp: time.Now().Unix(),
		Nodes:     make([]clusterNodeStatus, 0, len(req.Nodes)),
	}

	for i, node := range req.Nodes {
		status := h.inspectClusterNode(node)
		if status.ID == "" {
			status.ID = fmt.Sprintf("node-%d", i+1)
		}
		resp.Nodes = append(resp.Nodes, status)

		resp.Summary.TotalNodes++
		if status.Connected {
			resp.Summary.ConnectedNodes++
		}
		if strings.EqualFold(status.ClusterType, "physical") {
			resp.Summary.PhysicalNodes++
		}
		if strings.EqualFold(status.ClusterType, "logical") {
			resp.Summary.LogicalNodes++
		}
	}

	writeJSON(w, r, http.StatusOK, resp)
}

func (h *Handler) ServeClusterNodeInspect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		h.writeError(w, r, http.StatusMethodNotAllowed, "POST required")
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 128*1024))
	if err != nil {
		h.writeError(w, r, http.StatusBadRequest, "failed to read body")
		return
	}
	defer r.Body.Close()

	var node clusterNodeRequest
	if err := json.Unmarshal(body, &node); err != nil {
		h.writeError(w, r, http.StatusBadRequest, "invalid JSON")
		return
	}

	if node.Host == "" {
		h.writeError(w, r, http.StatusBadRequest, "host is required")
		return
	}

	status := h.inspectClusterNode(node)
	writeJSON(w, r, http.StatusOK, map[string]any{
		"success": true,
		"node":    status,
	})
}

func (h *Handler) inspectClusterNode(node clusterNodeRequest) clusterNodeStatus {
	host := orDefaultStr(node.Host, h.config.PGHost)
	port := orDefaultInt(node.Port, h.config.PGPort)
	user := orDefaultStr(node.User, h.config.PGUser)
	password := orDefaultStr(node.Password, h.config.PGPassword)
	db := orDefaultStr(node.Database, h.config.PGDatabase)
	clusterType := strings.ToLower(orDefaultStr(node.ClusterType, "physical"))

	status := clusterNodeStatus{
		ID:          node.ID,
		Name:        orDefaultStr(node.Name, host),
		Host:        host,
		Port:        port,
		Database:    db,
		ClusterType: clusterType,
		Role:        orDefaultStr(node.Role, "unknown"),
	}

	client := &pg.Client{}
	if err := client.Connect(host, port, user, password, db); err != nil {
		status.Error = err.Error()
		return status
	}
	defer client.Close()

	status.Connected = true
	if version, err := client.GetVersion(); err == nil {
		status.Version = version
	}
	if rec, err := querySingleText(client, "SELECT pg_is_in_recovery()::text AS v"); err == nil {
		status.InRecovery = rec == "true"
	}
	if lsn, err := querySingleText(client, "SELECT pg_current_wal_lsn()::text AS v"); err == nil {
		status.CurrentLSN = lsn
	}
	if replayLSN, err := querySingleText(client, "SELECT coalesce(pg_last_wal_replay_lsn()::text,'') AS v"); err == nil {
		status.ReplayLSN = replayLSN
	}
	if wr, err := querySingleText(client, "SELECT coalesce(status,'') AS v FROM pg_stat_wal_receiver LIMIT 1"); err == nil {
		status.WalReceiverStatus = wr
	}

	if rows, err := client.Execute(`
		SELECT coalesce(application_name,'') AS application_name,
		       coalesce(state,'') AS state,
		       coalesce(sync_state,'') AS sync_state,
		       coalesce(sent_lsn::text,'') AS sent_lsn,
		       coalesce(write_lsn::text,'') AS write_lsn,
		       coalesce(flush_lsn::text,'') AS flush_lsn,
		       coalesce(replay_lsn::text,'') AS replay_lsn,
		       coalesce(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)::bigint,0)::text AS lag_bytes,
		       coalesce(write_lag::text,'') AS write_lag,
		       coalesce(flush_lag::text,'') AS flush_lag,
		       coalesce(replay_lag::text,'') AS replay_lag
		FROM pg_stat_replication
		ORDER BY application_name`); err == nil && rows != nil {
		for _, row := range rows.Rows {
			lag, _ := strconv.ParseInt(row["lag_bytes"], 10, 64)
			status.PhysicalReplication = append(status.PhysicalReplication, replicationChannel{
				Name:      row["application_name"],
				State:     row["state"],
				SyncState: row["sync_state"],
				SentLSN:   row["sent_lsn"],
				WriteLSN:  row["write_lsn"],
				FlushLSN:  row["flush_lsn"],
				ReplayLSN: row["replay_lsn"],
				LagBytes:  lag,
				WriteLag:  row["write_lag"],
				FlushLag:  row["flush_lag"],
				ReplayLag: row["replay_lag"],
			})
		}
	}

	if n, err := querySingleInt(client, "SELECT count(*) AS v FROM pg_replication_slots WHERE slot_type='logical'"); err == nil {
		status.LogicalSlots = n
	}
	if n, err := querySingleInt(client, "SELECT count(*) AS v FROM pg_publication"); err == nil {
		status.Publications = n
	}
	if rows, err := client.Execute(`
		SELECT coalesce(s.subname,'') AS subname,
		       coalesce(s.subenabled::text,'false') AS subenabled,
		       coalesce(ss.worker_type,'') AS worker_type,
		       coalesce(ss.received_lsn::text,'') AS received_lsn,
		       coalesce(ss.latest_end_lsn::text,'') AS latest_end_lsn,
		       coalesce(ss.latest_end_time::text,'') AS latest_end_time
		FROM pg_subscription s
		LEFT JOIN pg_stat_subscription ss ON s.oid = ss.subid
		ORDER BY s.subname`); err == nil && rows != nil {
		for _, row := range rows.Rows {
			status.Subscriptions = append(status.Subscriptions, logicalSubscription{
				Name:          row["subname"],
				Enabled:       row["subenabled"] == "true",
				WorkerType:    row["worker_type"],
				ReceivedLSN:   row["received_lsn"],
				LatestEndLSN:  row["latest_end_lsn"],
				LatestEndTime: row["latest_end_time"],
			})
		}
	}

	_ = clusterType
	return status
}

func querySingleText(client *pg.Client, sql string) (string, error) {
	res, err := client.Execute(sql)
	if err != nil {
		return "", err
	}
	if res == nil || len(res.Rows) == 0 {
		return "", fmt.Errorf("no rows")
	}
	return res.Rows[0]["v"], nil
}

func querySingleInt(client *pg.Client, sql string) (int, error) {
	text, err := querySingleText(client, sql)
	if err != nil {
		return 0, err
	}
	v, err := strconv.Atoi(text)
	if err != nil {
		return 0, err
	}
	return v, nil
}

// ─── WAL ─────────────────────────────────────────────────────────────────────

type walRequest struct {
	StartLSN string `json:"start_lsn"` // optional LSN to start from
	Segment  string `json:"segment"`   // optional specific segment name
	Limit    int    `json:"limit"`     // max records (default 100)
}

type walRecordResponse struct {
	LSN        string                 `json:"lsn"`
	RmgrName   string                 `json:"rmgrName"`
	Operation  string                 `json:"operation,omitempty"`
	Info       uint8                  `json:"info"`
	Xid        uint32                 `json:"xid"`
	RecordLen  uint32                 `json:"recordLen"`
	PayloadLen uint32                 `json:"payloadLen"`
	PrevLSN    string                 `json:"prevLsn,omitempty"`
	PageOffset uint32                 `json:"pageOffset,omitempty"`
	Blocks     []wal.BlockRef         `json:"blocks,omitempty"`
	Details    map[string]interface{} `json:"details,omitempty"`
}

type walResponse struct {
	Records []walRecordResponse `json:"records"`
	Segment string              `json:"segment,omitempty"`
	DataDir string              `json:"dataDir,omitempty"`
	Limit   int                 `json:"limit"`
	Note    string              `json:"note,omitempty"`
}

func (h *Handler) ServeWAL(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		h.writeError(w, r, http.StatusMethodNotAllowed, "GET required")
		return
	}

	limit := parseIntQuery(r, "limit", 100)
	if limit <= 0 {
		limit = 100
	}
	if limit > 1000 {
		limit = 1000
	}

	dataDir := h.pgDataDir()
	reader := wal.NewWALReader(dataDir)
	segments, err := reader.ListWALSegments()
	if err != nil || len(segments) == 0 {
		writeJSON(w, r, http.StatusOK, walResponse{
			Records: []walRecordResponse{},
			DataDir: dataDir,
			Limit:   limit,
			Note:    "WAL segments unavailable. Check that pg_wal is mounted and PG is running.",
		})
		return
	}
	sort.Strings(segments)

	// Determine which segment to read
	var segmentPath string
	if seg := r.URL.Query().Get("segment"); seg != "" {
		// Find requested segment
		for _, s := range segments {
			if filepath.Base(s) == seg {
				segmentPath = s
				break
			}
		}
		if segmentPath == "" {
			h.writeError(w, r, http.StatusBadRequest, "segment not found: "+seg)
			return
		}
	} else {
		// Use newest segment
		segmentPath = segments[len(segments)-1]
	}

	// Parse start offset if provided
	startOffset := 0
	if startLSN := r.URL.Query().Get("start_lsn"); startLSN != "" {
		startOffset = parseLSNOffset(startLSN)
	}

	segNum := extractSegNum(filepath.Base(segmentPath))
	records, err := reader.ReadRecords(segmentPath, segNum, startOffset, limit)
	if err != nil {
		writeJSON(w, r, http.StatusOK, walResponse{
			Records: []walRecordResponse{},
			Segment: filepath.Base(segmentPath),
			DataDir: dataDir,
			Limit:   limit,
			Note:    err.Error(),
		})
		return
	}

	resp := walResponse{
		Records: make([]walRecordResponse, 0, len(records)),
		Segment: filepath.Base(segmentPath),
		DataDir: dataDir,
		Limit:   limit,
	}
	for _, rec := range records {
		resp.Records = append(resp.Records, walRecordResponse{
			LSN:        rec.LSN,
			RmgrName:   rec.RmgrName,
			Operation:  rec.Operation,
			Info:       rec.Info,
			Xid:        rec.Xid,
			RecordLen:  rec.RecordLen,
			PayloadLen: rec.PayloadLen,
			PrevLSN:    rec.PrevLSN,
			PageOffset: rec.PageOffset,
			Blocks:     rec.Blocks,
			Details:    rec.Details,
		})
	}

	if len(resp.Records) == 0 {
		resp.Note = "No WAL records parsed from the selected segment yet."
	}

	writeJSON(w, r, http.StatusOK, resp)
}

// ─── WAL Segments list ────────────────────────────────────────────────────────

type walSegmentsResponse struct {
	Segments []string `json:"segments"`
	DataDir  string   `json:"dataDir,omitempty"`
	Count    int      `json:"count"`
}

// ServeWALSegments handles GET /api/wal/segments — list available WAL segments
func (h *Handler) ServeWALSegments(w http.ResponseWriter, r *http.Request) {
	dataDir := h.pgDataDir()
	reader := wal.NewWALReader(dataDir)
	segments, err := reader.ListWALSegments()
	if err != nil {
		h.writeError(w, r, http.StatusInternalServerError, "wal_segments: "+err.Error())
		return
	}
	names := make([]string, len(segments))
	for i, s := range segments {
		names[i] = filepath.Base(s)
	}
	sort.Strings(names)
	writeJSON(w, r, http.StatusOK, walSegmentsResponse{
		Segments: names,
		DataDir:  dataDir,
		Count:    len(names),
	})
}

// ─── CLOG ─────────────────────────────────────────────────────────────────────

type clogResponse struct {
	Transactions []clogTransactionResponse `json:"transactions"`
	StartXid     uint32                    `json:"startXid"`
	EndXid       uint32                    `json:"endXid"`
	DataDir      string                    `json:"dataDir,omitempty"`
	Note         string                    `json:"note,omitempty"`
}

type clogTransactionResponse struct {
	Xid    uint32 `json:"xid"`
	Status string `json:"status"`
}

// ServeCLOGStatus handles GET /api/clog/status — return CLOG overview (segment list + stats).
func (h *Handler) ServeCLOGStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		h.writeError(w, r, http.StatusMethodNotAllowed, "GET required")
		return
	}
	dataDir := h.pgDataDir()
	clogDir := filepath.Join(dataDir, "pg_xact")
	entries, err := os.ReadDir(clogDir)
	if err != nil {
		h.writeError(w, r, http.StatusInternalServerError, "failed to read pg_xact: "+err.Error())
		return
	}
	var segments []string
	for _, e := range entries {
		if !e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
			segments = append(segments, e.Name())
		}
	}
	sort.Strings(segments)
	writeJSON(w, r, http.StatusOK, map[string]any{
		"segments": segments,
		"count":    len(segments),
		"dataDir":  dataDir,
		"clogDir":  clogDir,
	})
}

func (h *Handler) ServeCLOG(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		h.writeError(w, r, http.StatusMethodNotAllowed, "GET required")
		return
	}

	startXid, endXid := h.resolveXidRange(r)
	dataDir := h.pgDataDir()
	reader := clog.NewCLOGReader(dataDir)
	transactions, err := reader.ReadRange(startXid, endXid)
	if err != nil {
		writeJSON(w, r, http.StatusInternalServerError, clogResponse{
			Transactions: []clogTransactionResponse{},
			StartXid:     startXid,
			EndXid:       endXid,
			DataDir:      dataDir,
			Note:         err.Error(),
		})
		return
	}

	if startXid == 0 && endXid == 0 {
		writeJSON(w, r, http.StatusBadRequest, map[string]any{
			"success": false,
			"error":   "missing query parameters: startXid and endXid are required",
		})
		return
	}

	resp := clogResponse{
		Transactions: make([]clogTransactionResponse, 0, len(transactions)),
		StartXid:     startXid,
		EndXid:       endXid,
		DataDir:      dataDir,
	}
	for _, tx := range transactions {
		resp.Transactions = append(resp.Transactions, clogTransactionResponse{
			Xid:    tx.Xid,
			Status: tx.Name,
		})
	}

	if len(resp.Transactions) == 0 {
		resp.Note = "No CLOG/pg_xact transactions were read for the requested range."
	}

	writeJSON(w, r, http.StatusOK, resp)
}

// ServeCLOGFile reads a single CLOG segment file by name (e.g. /api/clog/0000).
func (h *Handler) ServeCLOGFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		h.writeError(w, r, http.StatusMethodNotAllowed, "GET required")
		return
	}
	// Extract filename from path: /api/clog/{filename}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/clog/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		h.writeError(w, r, http.StatusBadRequest, "missing segment filename")
		return
	}
	filename := parts[0]

	// Validate filename is exactly 4 hex digits (CLOG segment name)
	if !isHexSegmentName(filename) {
		h.writeError(w, r, http.StatusBadRequest, "invalid segment filename: must be 4 hex digits (e.g., 0000, 00FF)")
		return
	}

	dataDir := h.pgDataDir()
	clogDir := filepath.Join(dataDir, "pg_xact")
	filePath := filepath.Join(clogDir, filename)

	entries, err := readCLOGFile(filePath)
	if err != nil {
		if os.IsNotExist(err) {
			h.writeError(w, r, http.StatusNotFound, "segment file not found: "+filename)
			return
		}
		h.writeError(w, r, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, r, http.StatusOK, map[string]any{
		"filename":     filename,
		"path":         filePath,
		"total":        len(entries),
		"transactions": entries,
	})
}

// readCLOGFile reads all transactions from a single CLOG segment file.
func readCLOGFile(filePath string) ([]map[string]any, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil {
		return nil, err
	}
	fileSize := stat.Size()
	numPages := int(fileSize / clog.PageSize)
	if fileSize%clog.PageSize != 0 {
		numPages++
	}

	// Each file (segment) contains pagesPerSegment pages = 32 pages = 262144 XIDs
	// The segment file number encodes the base XID: segNum * 262144
	segmentBase := filepath.Base(filePath)
	segNum, _ := strconv.ParseUint(segmentBase, 16, 32)

	var results []map[string]any
	for pageIdx := 0; pageIdx < numPages; pageIdx++ {
		absolutePage := int(uint32(segNum)*uint32(clog.PagesPerSegment)) + pageIdx
		page, err := (&clog.CLOGReader{}).ReadPage(filePath, pageIdx)
		if err != nil {
			continue
		}
		for _, tx := range page.Transactions {
			results = append(results, map[string]any{
				"xid":    tx.Xid,
				"status": tx.Name,
			})
		}
		_ = absolutePage
	}
	return results, nil
}

// ServeSnapshot returns a combined snapshot of backend processes,
// active locks, and transaction states by querying pg_stat_activity + pg_locks.
func (h *Handler) ServeSnapshot(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		h.writeError(w, r, http.StatusMethodNotAllowed, "GET required")
		return
	}

	_, client := h.connMgr.GetActive()
	if client == nil {
		h.writeError(w, r, http.StatusServiceUnavailable, "no database connection")
		return
	}

	// Query backend processes via Execute (the only public method)
	// Note: PG 18 renamed columns — no "xid" column; use backend_xid, backend_xmin
	rows, err := client.Execute(`
		SELECT pid, usename, datname, state, query_start, backend_xid, backend_xmin, backend_type,
		       coalesce(wait_event_type,'') as wait_event_type, coalesce(wait_event,'') as wait_event,
		       left(coalesce(query,'<idle>'), 200) as query
		FROM pg_stat_activity
		WHERE datid IS NOT NULL OR pid = pg_backend_pid()
		ORDER BY pid`)
	if err != nil {
		h.writeError(w, r, http.StatusInternalServerError, "pg_stat_activity: "+err.Error())
		return
	}

	var backends []map[string]any
	if rows != nil && len(rows.Rows) > 0 {
		cols := rows.Columns
		for _, row := range rows.Rows {
			m := map[string]any{}
			for _, col := range cols {
				m[col.Name] = row[col.Name]
			}
			backends = append(backends, m)
		}
	}

	// Query lock information
	lrows, err := client.Execute(`
		SELECT coalesce(locktype,'') as locktype, coalesce(relation::text,'') as relation,
		       coalesce(virtualxid,'') as virtualxid, coalesce(transactionid::text,'') as transactionid,
		       coalesce(mode,'') as mode, coalesce(granted::text,'') as granted,
		       pid
		FROM pg_locks
		ORDER BY pid`)
	if err != nil {
		h.writeError(w, r, http.StatusInternalServerError, "pg_locks: "+err.Error())
		return
	}

	var locks []map[string]any
	if lrows != nil && len(lrows.Rows) > 0 {
		cols := lrows.Columns
		for _, row := range lrows.Rows {
			m := map[string]any{}
			for _, col := range cols {
				m[col.Name] = row[col.Name]
			}
			locks = append(locks, m)
		}
	}

	// Current XID
	var currentXid int64
	if xid, err := client.GetCurrentXid(); err == nil {
		currentXid = int64(xid)
	}

	writeJSON(w, r, http.StatusOK, map[string]any{
		"timestamp":     time.Now().Unix(),
		"current_xid":   currentXid,
		"backends":      backends,
		"locks":         locks,
		"backend_count": len(backends),
		"lock_count":    len(locks),
	})
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

func (h *Handler) ServeWS(w http.ResponseWriter, r *http.Request) {
	ws.ServeWs(h.hub, w, r)
}

func SetupRoutes(h *Handler, mux *http.ServeMux) {
	mux.HandleFunc("/health", h.ServeHealth)
	mux.HandleFunc("/readyz", h.ServeReadyz)
	mux.HandleFunc("/livez", h.ServeLivez)
	mux.HandleFunc("/version", h.ServeVersion)
	mux.HandleFunc("/api/openapi.json", openapi.Handler())
	mux.Handle("/metrics", h.metricsHandler())
	mux.HandleFunc("/api/connect", h.ServeConnect)
	mux.HandleFunc("/api/execute", h.ServeExecute)
	mux.HandleFunc("/api/workspace/projects", h.ServeWorkspaceProjects)
	mux.HandleFunc("/api/workspace/projects/", h.ServeWorkspaceProjectByID)
	mux.HandleFunc("/api/projects", h.ServeProjectList)
	mux.HandleFunc("/api/projects/", h.ServeProjectByID)
	mux.HandleFunc("/api/clusters/", func(w http.ResponseWriter, r *http.Request) {
	if strings.HasSuffix(r.URL.Path, "/teardown") && r.Method == http.MethodPost {
	h.ServeClusterTeardown(w, r)
	return
	}
	h.ServeClusterByID(w, r)
	})
	// Cluster overview: GET /api/cluster/{id}/overview (new) and POST /api/cluster/overview (legacy)
	mux.HandleFunc("/api/cluster/", func(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/overview") {
	h.ServeClusterOverview(w, r)
	return
	}
	if r.Method == http.MethodPost && r.URL.Path == "/api/cluster/overview" {
	h.ServeClusterOverviewLegacy(w, r)
	return
	}
	h.writeError(w, r, http.StatusNotFound, "not found")
	})
	mux.HandleFunc("/api/cluster/node/inspect", h.ServeClusterNodeInspect)
	mux.HandleFunc("/api/wal", h.ServeWAL)
	mux.HandleFunc("/api/wal/segments", h.ServeWALSegments)
	mux.HandleFunc("/api/clog/status", h.ServeCLOGStatus)
	mux.HandleFunc("/api/clog", h.ServeCLOG)
	mux.HandleFunc("/api/clog/", h.ServeCLOGFile)
	mux.HandleFunc("/api/snapshot", h.ServeSnapshot)
	mux.HandleFunc("/api/provision/single", h.ServeProvisionSingle)
	mux.HandleFunc("/api/provision/physical", h.ServeProvisionPhysical)
	mux.HandleFunc("/api/provision/logical", h.ServeProvisionLogical)
	mux.HandleFunc("/api/provision/tasks/", h.ServeProvisionTask)
	mux.HandleFunc("/api/provision/tasks", h.ServeProvisionTasks)
	mux.HandleFunc("/api/discovery/host/scan", h.ServeDiscoveryHostScan)
	mux.HandleFunc("/api/discovery/host/import", h.ServeDiscoveryHostImport)
	mux.HandleFunc("/api/discovery/dsn/validate", h.ServeDiscoveryDSNValidate)
	mux.HandleFunc("/api/discovery/dsn/import", h.ServeDiscoveryDSNImport)
	mux.HandleFunc("/ws", h.ServeWS)

	// Node activation/deactivation/register/status dispatcher
	mux.HandleFunc("/api/nodes/", func(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
	if strings.HasSuffix(r.URL.Path, "/activate") {
	h.ServeNodeActivate(w, r)
	return
	}
	if strings.HasSuffix(r.URL.Path, "/deactivate") {
	h.ServeNodeDeactivate(w, r)
	return
	}
	if strings.HasSuffix(r.URL.Path, "/register") {
	h.ServeNodeRegister(w, r)
	return
	}
	h.writeError(w, r, http.StatusNotFound, "not found")
	case http.MethodGet:
	if strings.HasSuffix(r.URL.Path, "/status") {
	h.ServeNodeStatus(w, r)
	return
	}
	h.ServeNodeByID(w, r)
	default:
	h.writeError(w, r, http.StatusMethodNotAllowed, "POST/GET required")
	}
	})

	// Host CRUD
	mux.HandleFunc("/api/hosts", h.ServeHostList)
	mux.HandleFunc("/api/hosts/", h.ServeHostByID)

	// Task list/detail
	mux.HandleFunc("/api/tasks", h.ServeTaskList)
	mux.HandleFunc("/api/tasks/", h.ServeTaskByID)

	// Frontend telemetry: best-effort ingestion of error reports
	// and Web Vitals samples. Always returns 202 — the frontend must
	// never be penalised for telemetry failures.
	mux.HandleFunc("/api/telemetry/errors", h.ServeTelemetryErrors)
	mux.HandleFunc("/api/telemetry/errors/top", h.ServeTelemetryErrorsTop)
	mux.HandleFunc("/api/telemetry/vitals", h.ServeTelemetryVitals)
}


// ─── Frontend telemetry ──────────────────────────────────────────────────────

// telemetryEnvelope is the shape the frontend posts. We keep it
// permissive (interface{}) so a frontend bug can't fail validation
// here.
type telemetryEnvelope struct {
	Reports  []json.RawMessage `json:"reports"`
	Samples  []json.RawMessage `json:"samples"`
}

// telemetryReport is the parsed shape of a single client error. The
// telemetry store dedups on (message, stack, url) so the parsing
// tolerates unknown breadcrumb fields but requires the core fields
// below.
type telemetryReport struct {
	EventID     string                 `json:"eventId"`
	Timestamp   string                 `json:"timestamp"`
	Level       string                 `json:"level"`
	Message     string                 `json:"message"`
	Stack       string                 `json:"stack"`
	URL         string                 `json:"url"`
	UserAgent   string                 `json:"userAgent"`
	Breadcrumbs []json.RawMessage      `json:"breadcrumbs,omitempty"`
	Extra       map[string]any         `json:"-"`
}

func (h *Handler) ServeTelemetryErrors(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		h.writeError(w, r, http.StatusMethodNotAllowed, "POST required")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		h.writeError(w, r, http.StatusBadRequest, "read body: "+err.Error())
		return
	}
	var env telemetryEnvelope
	if len(body) > 0 {
		if err := json.Unmarshal(body, &env); err != nil {
			h.writeError(w, r, http.StatusBadRequest, "decode: "+err.Error())
			return
		}
	}
	newCount, dupCount := 0, 0
	for _, raw := range env.Reports {
		var rep telemetryReport
		if err := json.Unmarshal(raw, &rep); err != nil {
			// One bad report should not poison the batch — log and skip.
			slog.Warn("telemetry: skipping unparseable report", "err", err.Error())
			continue
		}
		if h.telemetry != nil {
			before := h.telemetry.Len()
			h.telemetry.Record(telemetrystore.RecordInput{
				EventID:   rep.EventID,
				Level:     rep.Level,
				Message:   rep.Message,
				URL:       rep.URL,
				UserAgent: rep.UserAgent,
				Stack:     rep.Stack,
				Timestamp: parseTimestamp(rep.Timestamp),
			})
			if h.telemetry.Len() > before {
				newCount++
			} else {
				dupCount++
			}
		} else {
			// No store configured (memory-only / disabled). Still log so
			// the operator sees the report in stdout.
			slog.Info("telemetry error", "report", string(raw))
		}
	}
	// 202 Accepted — fire-and-forget.
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	fmt.Fprintf(w, `{"accepted":true,"new":%d,"deduped":%d}`, newCount, dupCount)
}

// ServeTelemetryErrorsTop returns the most recently seen distinct
// errors, ordered by LastSeen desc.
//
// Query params:
//   - limit=N  (default 20, max 100) — top-N cap on the response
//   - since=Go-duration (e.g. "1h", "24h", "15m") — only events
//     whose LastSeen is within this window are returned. Missing or
//     unparseable means "all time".
func (h *Handler) ServeTelemetryErrorsTop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		h.writeError(w, r, http.StatusMethodNotAllowed, "GET required")
		return
	}
	if h.telemetry == nil {
		writeJSON(w, r, http.StatusOK, map[string]any{"events": []any{}, "total": 0})
		return
	}
	q := r.URL.Query()
	limit := 20
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
		if limit > 100 {
			limit = 100
		}
	}
	since := time.Time{}
	if v := q.Get("since"); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			since = time.Now().UTC().Add(-d)
		}
	}
	events := h.telemetry.TopSince(limit, since)
	writeJSON(w, r, http.StatusOK, map[string]any{
		"events":     events,
		"total":      h.telemetry.Len(),
		"in_window":  len(events),
		"since_used": !since.IsZero(),
	})
}

// CloseTelemetry flushes the telemetry store. Safe to call multiple
// times. Called by main on graceful shutdown.
func (h *Handler) CloseTelemetry() error {
	if h.telemetry == nil {
		return nil
	}
	return h.telemetry.Close()
}

func (h *Handler) ServeTelemetryVitals(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		h.writeError(w, r, http.StatusMethodNotAllowed, "POST required")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 256*1024))
	if err != nil {
		h.writeError(w, r, http.StatusBadRequest, "read body: "+err.Error())
		return
	}
	var env telemetryEnvelope
	if len(body) > 0 {
		if err := json.Unmarshal(body, &env); err != nil {
			h.writeError(w, r, http.StatusBadRequest, "decode: "+err.Error())
			return
		}
	}
	for _, raw := range env.Samples {
		slog.Info("telemetry vital", "sample", string(raw))
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_, _ = w.Write([]byte(`{"accepted":true}`))
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func (h *Handler) pgDataDir() string {
	_, client := h.connMgr.GetActive()
	if client != nil {
		if dataDir, err := client.GetPGDataDir(); err == nil && dataDir != "" {
			if _, err := os.Stat(dataDir); err == nil {
				return dataDir
			}
		}
	}
	return h.config.PGDataDir
}

func (h *Handler) resolveXidRange(r *http.Request) (uint32, uint32) {
	startXid := uint32(parseIntQuery(r, "start_xid", 0))
	endXid := uint32(parseIntQuery(r, "end_xid", 0))
	if startXid > 0 && endXid >= startXid {
		return startXid, endXid
	}

	// Try active client first
	_, client := h.connMgr.GetActive()
	if client != nil {
		if xid, err := client.GetCurrentXid(); err == nil && xid > 0 {
			end := uint32(xid)
			start := uint32(0)
			if end > 255 {
				start = end - 255
			}
			return start, end
		}
	}

	// Fallback: infer XID range from pg_xact filenames (no DB connection needed)
	// Try both PG_DATA_DIR and PG_DATA_DIR/data since the mount point varies.
	candidates := []string{h.pgDataDir(), filepath.Join(h.pgDataDir(), "data")}
	for _, dataDir := range candidates {
		if dataDir == "" {
			continue
		}
		pgXactDir := filepath.Join(dataDir, "pg_xact")
		if files, err := os.ReadDir(pgXactDir); err == nil {
			maxFileNum := uint32(0)
			for _, f := range files {
				name := f.Name()
				if len(name) == 4 {
					if n, err := strconv.ParseUint(name, 16, 32); err == nil {
						if uint32(n) > maxFileNum {
							maxFileNum = uint32(n)
						}
					}
				}
			}
			// Each file covers 1048576 XIDs (8 bits per XID, 8192 bytes/page)
			maxXid := (maxFileNum+1)*65536 - 1
			start := uint32(0)
			if maxXid > 255 {
				start = maxXid - 255
			}
			return start, maxXid
		}
	}
	return 0, 255
}

func parseIntQuery(r *http.Request, key string, defaultValue int) int {
	if v := r.URL.Query().Get(key); v != "" {
		if parsed, err := strconv.Atoi(v); err == nil {
			return parsed
		}
	}
	return defaultValue
}

// parseLSNOffset extracts the byte offset from an LSN string like "0/16D4F30".
// Returns 0 if parsing fails.
func parseLSNOffset(lsn string) int {
	parts := splitLSN(lsn)
	if len(parts) != 2 {
		return 0
	}
	n, err := strconv.ParseUint(parts[1], 16, 32)
	if err != nil {
		return 0
	}
	return int(n)
}

func splitLSN(lsn string) []string {
	for i := 0; i < len(lsn); i++ {
		if lsn[i] == '/' {
			return []string{lsn[:i], lsn[i+1:]}
		}
	}
	return nil
}

// dirExists checks if a directory exists on the filesystem.
func dirExists(path string) bool {
	if path == "" {
		return false
	}
	if _, err := os.Stat(path); err == nil {
		return true
	}
	return false
}

// orDefaultInt returns def if val is 0, otherwise val.
func orDefaultInt(val, def int) int {
	if val == 0 {
		return def
	}
	return val
}

// orDefaultStr returns def if val is empty, otherwise val.
func orDefaultStr(val, def string) string {
	if val == "" {
		return def
	}
	return val
}

func extractSegNum(filename string) uint64 {
	if len(filename) >= 8 {
		var segNum uint64
		if _, err := fmt.Sscanf(filename[len(filename)-8:], "%x", &segNum); err == nil {
			return segNum
		}
	}
	return 0
}

// isHexSegmentName returns true if filename is exactly 4 uppercase hex digits.
func isHexSegmentName(filename string) bool {
	if len(filename) != 4 {
		return false
	}
	for _, c := range filename {
		if !((c >= '0' && c <= '9') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

// extractClusterIDFromPath extracts the cluster ID from a path like /api/cluster/{id}/overview.
func extractClusterIDFromPath(path string) string {
	parts := strings.TrimPrefix(path, "/api/cluster/")
	i := strings.Index(parts, "/")
	if i >= 0 {
		return parts[:i]
	}
	return strings.TrimSpace(parts)
}

// inspectNodeByID looks up a node in the workspace store by node ID and returns its status.
func (h *Handler) inspectNodeByID(nodeID string) clusterNodeStatus {
	projects, _, _ := h.workspace.readSnapshot()
	var node workspaceNode
	for pi := range projects {
		for ci := range projects[pi].Clusters {
			for ni := range projects[pi].Clusters[ci].Nodes {
				if projects[pi].Clusters[ci].Nodes[ni].ID == nodeID {
					node = projects[pi].Clusters[ci].Nodes[ni]
				}
			}
		}
	}
	if node.ID == "" {
		return clusterNodeStatus{ID: nodeID, Error: "node not found in workspace"}
	}

	status := clusterNodeStatus{
		ID:          node.ID,
		Name:        node.Name,
		Host:        node.Host,
		Port:        node.Port,
		Database:    node.Database,
		ClusterType: node.ClusterType,
		Role:        node.Role,
	}

	// Try existing connection first
	client, err := h.connMgr.Get(nodeID)
	if err != nil {
		// Register and activate
		h.connMgr.Register(nodeID, connection.Config{
			Host:     node.Host,
			Port:     node.Port,
			User:     node.User,
			Password: node.Password,
			Database: node.Database,
		})
		if err2 := h.connMgr.Activate(nodeID); err2 != nil {
			status.Error = "activation failed: " + err2.Error()
			return status
		}
		client, err = h.connMgr.Get(nodeID)
		if err != nil {
			status.Error = "failed to get connection after activation: " + err.Error()
			return status
		}
	}

	return h.inspectNodeClient(node, client)
}

// inspectNodeClient inspects a connected node using an already-established pg.Client.
func (h *Handler) inspectNodeClient(node workspaceNode, client *pg.Client) clusterNodeStatus {
	status := clusterNodeStatus{
		ID:          node.ID,
		Name:        node.Name,
		Host:        node.Host,
		Port:        node.Port,
		Database:    node.Database,
		ClusterType: node.ClusterType,
		Role:        node.Role,
	}
	if client == nil {
		return status
	}

	status.Connected = true
	if version, err := client.GetVersion(); err == nil {
		status.Version = version
	}
	if rec, err := querySingleText(client, "SELECT pg_is_in_recovery()::text AS v"); err == nil {
		status.InRecovery = rec == "true"
	}
	if lsn, err := querySingleText(client, "SELECT pg_current_wal_lsn()::text AS v"); err == nil {
		status.CurrentLSN = lsn
	}
	if replayLSN, err := querySingleText(client, "SELECT coalesce(pg_last_wal_replay_lsn()::text,'') AS v"); err == nil {
		status.ReplayLSN = replayLSN
	}
	if wr, err := querySingleText(client, "SELECT coalesce(status,'') AS v FROM pg_stat_wal_receiver LIMIT 1"); err == nil {
		status.WalReceiverStatus = wr
	}

	if rows, err := client.Execute(`
		SELECT coalesce(application_name,'') AS application_name,
		       coalesce(state,'') AS state,
		       coalesce(sync_state,'') AS sync_state,
		       coalesce(sent_lsn::text,'') AS sent_lsn,
		       coalesce(write_lsn::text,'') AS write_lsn,
		       coalesce(flush_lsn::text,'') AS flush_lsn,
		       coalesce(replay_lsn::text,'') AS replay_lsn,
		       coalesce(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)::bigint,0)::text AS lag_bytes,
		       coalesce(write_lag::text,'') AS write_lag,
		       coalesce(flush_lag::text,'') AS flush_lag,
		       coalesce(replay_lag::text,'') AS replay_lag
		FROM pg_stat_replication
		ORDER BY application_name`); err == nil && rows != nil {
		for _, row := range rows.Rows {
			lag, _ := strconv.ParseInt(row["lag_bytes"], 10, 64)
			status.PhysicalReplication = append(status.PhysicalReplication, replicationChannel{
				Name:      row["application_name"],
				State:     row["state"],
				SyncState: row["sync_state"],
				SentLSN:   row["sent_lsn"],
				WriteLSN:  row["write_lsn"],
				FlushLSN:  row["flush_lsn"],
				ReplayLSN: row["replay_lsn"],
				LagBytes:  lag,
				WriteLag:  row["write_lag"],
				FlushLag:  row["flush_lag"],
				ReplayLag: row["replay_lag"],
			})
		}
	}

	if n, err := querySingleInt(client, "SELECT count(*) AS v FROM pg_replication_slots WHERE slot_type='logical'"); err == nil {
		status.LogicalSlots = n
	}
	if n, err := querySingleInt(client, "SELECT count(*) AS v FROM pg_publication"); err == nil {
		status.Publications = n
	}
	if rows, err := client.Execute(`
		SELECT coalesce(s.subname,'') AS subname,
		       coalesce(s.subenabled::text,'false') AS subenabled,
		       coalesce(ss.worker_type,'') AS worker_type,
		       coalesce(ss.received_lsn::text,'') AS received_lsn,
		       coalesce(ss.latest_end_lsn::text,'') AS latest_end_lsn,
		       coalesce(ss.latest_end_time::text,'') AS latest_end_time
		FROM pg_subscription s
		LEFT JOIN pg_stat_subscription ss ON s.oid = ss.subid
		ORDER BY s.subname`); err == nil && rows != nil {
		for _, row := range rows.Rows {
			status.Subscriptions = append(status.Subscriptions, logicalSubscription{
				Name:          row["subname"],
				Enabled:       row["subenabled"] == "true",
				WorkerType:    row["worker_type"],
				ReceivedLSN:   row["received_lsn"],
				LatestEndLSN:  row["latest_end_lsn"],
				LatestEndTime: row["latest_end_time"],
			})
		}
	}

	return status
}


// truncate returns s shortened to at most n runes, with a trailing
// ellipsis when shortened. Used by the audit log so a 1MB INSERT
// doesn't bloat every audit record.
func truncate(s string, n int) string {
	if n <= 0 {
		return ""
	}
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "..."
}

// parseTimestamp parses RFC3339 client timestamps. Returns zero time on
// failure so the store treats it as "now" relative to ingest.
func parseTimestamp(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	if ts, err := time.Parse(time.RFC3339, s); err == nil {
		return ts
	}
	return time.Time{}
}
