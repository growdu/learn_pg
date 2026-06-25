package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// ─── Request / Response types ────────────────────────────────────────────────

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

// ─── HTTP handlers ───────────────────────────────────────────────────────────

// ServeDiscoveryHostScan handles POST /api/discovery/host/scan.
func (h *Handler) ServeDiscoveryHostScan(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		h.writeError(w, r, 405, "POST required")
		return
	}
	var req discoveryScanRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&req); err != nil {
		h.writeError(w, r, 400, "invalid JSON")
		return
	}
	host := strings.TrimSpace(req.Host)
	if host == "" {
		h.writeError(w, r, 400, "host is required")
		return
	}

	port := req.SSH.Port
	if port <= 0 {
		port = 5432
	}

	addr := fmt.Sprintf("%s:%d", host, port)

	// Step 1: TCP connectivity check
	if !portOpen(addr, 900*time.Millisecond) {
		writeJSON(w, r, 200, discoveryScanResponse{
			Success: true,
			Instances: []discoveryInstance{
				{
					Host:       host,
					Port:       port,
					Service:    "postgresql",
					Confidence: "low",
				},
			},
		})
		return
	}

	// Step 2: pg_isready validation
	version, reachable := pgIsReady(host, port)
	inst := discoveryInstance{
		Host:       host,
		Port:       port,
		Service:    "postgresql",
		Confidence: "high",
	}
	if reachable {
		inst.Version = version
	} else {
		inst.Confidence = "low"
	}

	writeJSON(w, r, 200, discoveryScanResponse{Success: true, Instances: []discoveryInstance{inst}})
}

// ServeDiscoveryHostImport handles POST /api/discovery/host/import.
func (h *Handler) ServeDiscoveryHostImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		h.writeError(w, r, 405, "POST required")
		return
	}
	var req discoveryImportRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&req); err != nil {
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

// ServeDiscoveryDSNValidate handles POST /api/discovery/dsn/validate.
func (h *Handler) ServeDiscoveryDSNValidate(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		h.writeError(w, r, 405, "POST required")
		return
	}
	var req dsnValidateRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&req); err != nil {
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

// ServeDiscoveryDSNImport handles POST /api/discovery/dsn/import.
func (h *Handler) ServeDiscoveryDSNImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		h.writeError(w, r, 405, "POST required")
		return
	}
	var req dsnImportRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&req); err != nil {
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
