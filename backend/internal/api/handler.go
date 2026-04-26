package api

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"path/filepath"
	"sort"
	"strconv"

	"pg-visualizer-backend/internal/config"
	"pg-visualizer-backend/internal/pg"
	"pg-visualizer-backend/internal/ws"
	"pg-visualizer-backend/pkg/clog"
	"pg-visualizer-backend/pkg/wal"
)

// Handler holds API dependencies
type Handler struct {
	config   *config.Config
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
	Status      string `json:"status"`
	PGConnected bool   `json:"pg_connected"`
}

// ServeHealth handles GET /health
func (h *Handler) ServeHealth(w http.ResponseWriter, r *http.Request) {
	resp := HealthResponse{
		Status:      "ok",
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
	log.Printf("[API] ServeConnect called")
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	log.Printf("[API] Reading body")
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read body", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	log.Printf("[API] Body: %s", string(body))
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
	password := req.Password
	if password == "" {
		password = h.config.PGPassword
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
	if err := client.Connect(host, port, user, password, db); err != nil {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ConnectResponse{
			Success: false,
			Message: err.Error(),
		})
		return
	}

	h.pgClient = client
	log.Printf("[API] PG client set, getting version")

	version, _ := client.GetVersion()
	log.Printf("[API] Got version: %s", version)
	dataDir, _ := client.GetPGDataDir()

	log.Printf("[API] Sending response")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(ConnectResponse{
		Success: true,
		Message: "Connected successfully",
		Version: version,
		DataDir: dataDir,
	})
	log.Printf("[API] Response sent")
}

// ExecuteRequest represents SQL execution request
type ExecuteRequest struct {
	SQL string `json:"sql"`
}

// ExecuteResponse represents SQL execution response
type ExecuteResponse struct {
	Success bool              `json:"success"`
	Result  *pg.ExecuteResult `json:"result,omitempty"`
	Error   string            `json:"error,omitempty"`
}

type WALRecordResponse struct {
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

type WALResponse struct {
	Records []WALRecordResponse `json:"records"`
	Segment string              `json:"segment,omitempty"`
	DataDir string              `json:"dataDir,omitempty"`
	Limit   int                 `json:"limit"`
	Note    string              `json:"note,omitempty"`
}

type CLOGTransactionResponse struct {
	Xid    uint32 `json:"xid"`
	Status string `json:"status"`
}

type CLOGResponse struct {
	Transactions []CLOGTransactionResponse `json:"transactions"`
	StartXid     uint32                    `json:"startXid"`
	EndXid       uint32                    `json:"endXid"`
	DataDir      string                    `json:"dataDir,omitempty"`
	Note         string                    `json:"note,omitempty"`
}

// ServeExecute handles POST /api/execute
func (h *Handler) ServeExecute(w http.ResponseWriter, r *http.Request) {
	log.Printf("[API] ServeExecute called method=%s", r.Method)
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
	limit := parseIntQuery(r, "limit", 100)
	dataDir := h.pgDataDir()
	reader := wal.NewWALReader(dataDir)
	segments, err := reader.ListWALSegments()
	if err != nil || len(segments) == 0 {
		writeJSON(w, WALResponse{
			Records: []WALRecordResponse{},
			DataDir: dataDir,
			Limit:   limit,
			Note:    "WAL segment unavailable. Confirm PG_DATA_DIR and mounted pg_wal access.",
		})
		return
	}

	sort.Strings(segments)
	segmentPath := segments[len(segments)-1]
	records, err := reader.TailRecords(limit)
	if err != nil {
		writeJSON(w, WALResponse{
			Records: []WALRecordResponse{},
			Segment: filepath.Base(segmentPath),
			DataDir: dataDir,
			Limit:   limit,
			Note:    err.Error(),
		})
		return
	}

	resp := WALResponse{
		Records: make([]WALRecordResponse, 0, len(records)),
		Segment: filepath.Base(segmentPath),
		DataDir: dataDir,
		Limit:   limit,
	}
	for _, record := range records {
		resp.Records = append(resp.Records, WALRecordResponse{
			LSN:        record.LSN,
			RmgrName:   record.RmgrName,
			Operation:  record.Operation,
			Info:       record.Info,
			Xid:        record.Xid,
			RecordLen:  record.RecordLen,
			PayloadLen: record.PayloadLen,
			PrevLSN:    record.PrevLSN,
			PageOffset: record.PageOffset,
			Blocks:     record.Blocks,
			Details:    record.Details,
		})
	}
	if len(resp.Records) == 0 {
		resp.Note = "No WAL records parsed from the selected segment yet."
	}
	writeJSON(w, resp)
}

// CLOGRequest represents CLOG query request
type CLOGRequest struct {
	StartXid uint32 `json:"start_xid"`
	EndXid   uint32 `json:"end_xid"`
}

// ServeCLOG handles GET /api/clog
func (h *Handler) ServeCLOG(w http.ResponseWriter, r *http.Request) {
	startXid, endXid := h.resolveXidRange(r)
	dataDir := h.pgDataDir()
	reader := clog.NewCLOGReader(dataDir)
	transactions, err := reader.ReadRange(startXid, endXid)
	if err != nil {
		writeJSON(w, CLOGResponse{
			Transactions: []CLOGTransactionResponse{},
			StartXid:     startXid,
			EndXid:       endXid,
			DataDir:      dataDir,
			Note:         err.Error(),
		})
		return
	}

	resp := CLOGResponse{
		Transactions: make([]CLOGTransactionResponse, 0, len(transactions)),
		StartXid:     startXid,
		EndXid:       endXid,
		DataDir:      dataDir,
	}
	for _, tx := range transactions {
		resp.Transactions = append(resp.Transactions, CLOGTransactionResponse{
			Xid:    tx.Xid,
			Status: tx.Name,
		})
	}
	if len(resp.Transactions) == 0 {
		resp.Note = "No CLOG/pg_xact transactions were read for the requested range."
	}
	writeJSON(w, resp)
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

func (h *Handler) pgDataDir() string {
	if h.pgClient != nil {
		if dataDir, err := h.pgClient.GetPGDataDir(); err == nil && dataDir != "" {
			return dataDir
		}
	}
	return h.config.PGDataDir
}

func (h *Handler) resolveXidRange(r *http.Request) (uint32, uint32) {
	startXid := parseIntQuery(r, "start_xid", -1)
	endXid := parseIntQuery(r, "end_xid", -1)
	if startXid >= 0 && endXid >= startXid {
		return uint32(startXid), uint32(endXid)
	}

	if h.pgClient != nil {
		currentXid, err := h.pgClient.GetCurrentXid()
		if err == nil && currentXid > 0 {
			end := uint32(currentXid)
			start := uint32(0)
			if end > 255 {
				start = end - 255
			}
			return start, end
		}
	}

	return 0, 255
}

func parseIntQuery(r *http.Request, key string, defaultValue int) int {
	value := r.URL.Query().Get(key)
	if value == "" {
		return defaultValue
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return defaultValue
	}
	return parsed
}

func writeJSON(w http.ResponseWriter, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(payload)
}
