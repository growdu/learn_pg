package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"pg-visualizer-backend/internal/config"
	"pg-visualizer-backend/internal/pg"
	"pg-visualizer-backend/internal/ws"
)

// Handler holds API dependencies
type Handler struct {
	config *config.Config
	pgClient *pg.Client
	hub      *ws.Hub
}

// NewHandler creates a new API handler
func NewHandler(cfg *config.Config, hub *ws.Hub) *Handler {
	return &Handler{
		config: cfg,
		hub:    hub,
	}
}

// SetPGClient sets the PostgreSQL client
func (h *Handler) SetPGClient(client *pg.Client) {
	h.pgClient = client
}

// HealthResponse represents health check response
type HealthResponse struct {
	Status     string `json:"status"`
	PGConnected bool   `json:"pg_connected"`
}

// ServeHealth handles GET /health
func (h *Handler) ServeHealth(w http.ResponseWriter, r *http.Request) {
	resp := HealthResponse{
		Status:     "ok",
		PGConnected: h.pgClient != nil,
	}
	if h.pgClient != nil {
		if err := h.pgClient.Ping(); err != nil {
			resp.PGConnected = false
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// ConnectRequest represents connection request
type ConnectRequest struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	User     string `json:"user"`
	Password string `json:"password"`
	Database string `json:"database"`
}

// ConnectResponse represents connection response
type ConnectResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
	Version string `json:"version,omitempty"`
	DataDir string `json:"data_dir,omitempty"`
}

// ServeConnect handles POST /api/connect
func (h *Handler) ServeConnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read body", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	var req ConnectRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Use defaults from config if not provided
	host := req.Host
	if host == "" {
		host = h.config.PGHost
	}
	port := req.Port
	if port == 0 {
		port = h.config.PGPort
	}
	user := req.User
	if user == "" {
		user = h.config.PGUser
	}
	db := req.Database
	if db == "" {
		db = h.config.PGDatabase
	}

	// Close existing connection
	if h.pgClient != nil {
		h.pgClient.Close()
	}

	// Create new connection
	client := &pg.Client{}
	if err := client.Connect(host, port, user, req.Password, db); err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ConnectResponse{
			Success: false,
			Message: err.Error(),
		})
		return
	}

	h.pgClient = client

	version, _ := client.GetVersion()
	dataDir, _ := client.GetPGDataDir()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(ConnectResponse{
		Success: true,
		Message: "Connected successfully",
		Version: version,
		DataDir: dataDir,
	})
}

// ExecuteRequest represents SQL execution request
type ExecuteRequest struct {
	SQL string `json:"sql"`
}

// ExecuteResponse represents SQL execution response
type ExecuteResponse struct {
	Success bool `json:"success"`
	Result  *pg.ExecuteResult
	Error   string `json:"error,omitempty"`
}

// ServeExecute handles POST /api/execute
func (h *Handler) ServeExecute(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if h.pgClient == nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ExecuteResponse{
			Success: false,
			Error:   "Not connected to PostgreSQL",
		})
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read body", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	var req ExecuteRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	result, err := h.pgClient.Execute(req.SQL)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ExecuteResponse{
			Success: false,
			Error:   err.Error(),
		})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(ExecuteResponse{
		Success: result.Error == "",
		Result:  result,
		Error:   result.Error,
	})
}

// WALRequest represents WAL query request
type WALRequest struct {
	StartLSN string `json:"start_lsn"`
	EndLSN   string `json:"end_lsn"`
	Limit    int    `json:"limit"`
}

// ServeWAL handles GET /api/wal
func (h *Handler) ServeWAL(w http.ResponseWriter, r *http.Request) {
	lsn := r.URL.Query().Get("lsn")
	if lsn == "" {
		lsn = h.config.PGDataDir
	}
	limit := 100

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"lsn":   lsn,
		"limit": limit,
		"note":  "WAL reading requires pg_wal access. Configure PG_DATA_DIR.",
	})
}

// CLOGRequest represents CLOG query request
type CLOGRequest struct {
	StartXid uint32 `json:"start_xid"`
	EndXid   uint32 `json:"end_xid"`
}

// ServeCLOG handles GET /api/clog
func (h *Handler) ServeCLOG(w http.ResponseWriter, r *http.Request) {
	startXid := r.URL.Query().Get("start_xid")
	endXid := r.URL.Query().Get("end_xid")

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"start_xid": startXid,
		"end_xid":   endXid,
		"note":      "CLOG reading requires pg_clog access. Configure PG_DATA_DIR.",
	})
}

// ServeWS handles WebSocket upgrade at /ws
func (h *Handler) ServeWS(w http.ResponseWriter, r *http.Request) {
	ws.ServeWs(h.hub, w, r)
}

// SetupRoutes configures all HTTP routes
func SetupRoutes(h *Handler, mux *http.ServeMux) {
	mux.HandleFunc("/health", h.ServeHealth)
	mux.HandleFunc("/api/connect", h.ServeConnect)
	mux.HandleFunc("/api/execute", h.ServeExecute)
	mux.HandleFunc("/api/wal", h.ServeWAL)
	mux.HandleFunc("/api/clog", h.ServeCLOG)
	mux.HandleFunc("/ws", h.ServeWS)
}

// Start starts the API server
func Start(h *Handler, addr string) error {
	mux := http.NewServeMux()
	SetupRoutes(h, mux)

	fmt.Printf("[API] Starting server on %s\n", addr)
	return http.ListenAndServe(addr, mux)
}