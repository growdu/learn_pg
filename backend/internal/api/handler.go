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
	"time"

	"pg-visualizer-backend/internal/config"
	"pg-visualizer-backend/internal/middleware"
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
	pgOK := h.pgClient != nil
	if pgOK {
		if err := h.pgClient.Ping(); err != nil {
			pgOK = false
		}
	}
	writeJSON(w, r, http.StatusOK, healthResponse{
		Status:      "ok",
		PGConnected: pgOK,
	})
}

// ServeReadyz handles GET /readyz — readiness probe (all deps up)
func (h *Handler) ServeReadyz(w http.ResponseWriter, r *http.Request) {
	pgOK := h.pgClient != nil && h.pgClient.Ping() == nil
	dataDir := h.pgDataDir()
	dataDirOK := dataDir != "" && dirExists(dataDir)

	if pgOK && dataDirOK {
		writeJSON(w, r, http.StatusOK, map[string]string{
			"status":   "ready",
			"pg":       "ok",
			"data_dir": dataDir,
		})
		return
	}

	status := "degraded"
	if !pgOK {
		status = "not_ready"
	}
	writeJSON(w, r, http.StatusServiceUnavailable, map[string]string{
		"status":   status,
		"pg":       map[bool]string{true: "ok", false: "unavailable"}[pgOK],
		"data_dir": dataDir,
	})
}

// ServeLivez handles GET /livez — liveness probe (process alive)
func (h *Handler) ServeLivez(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, r, http.StatusOK, map[string]string{"status": "alive"})
}

// ─── Connect ─────────────────────────────────────────────────────────────────

type connectRequest struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	User     string `json:"user"`
	Password string `json:"password"`
	Database string `json:"database"`
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

	host := orDefaultStr(req.Host, h.config.PGHost)
	port := orDefaultInt(req.Port, h.config.PGPort)
	user := orDefaultStr(req.User, h.config.PGUser)
	password := orDefaultStr(req.Password, h.config.PGPassword)
	db := orDefaultStr(req.Database, h.config.PGDatabase)

	// Close existing connection
	if h.pgClient != nil {
		h.pgClient.Close()
	}

	client := &pg.Client{}
	if err := client.Connect(host, port, user, password, db); err != nil {
		h.writeError(w, r, http.StatusBadGateway, err.Error())
		return
	}

	h.pgClient = client
	version, _ := client.GetVersion()
	dataDir, _ := client.GetPGDataDir()

	slog.Info("PG connected", "host", host, "port", port, "db", db, "version", version)
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
	Success bool                `json:"success"`
	Result  *pg.ExecuteResult  `json:"result,omitempty"`
	Error   string              `json:"error,omitempty"`
}

func (h *Handler) ServeExecute(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		h.writeError(w, r, http.StatusMethodNotAllowed, "POST required")
		return
	}
	if h.pgClient == nil {
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

	result, err := h.pgClient.Execute(req.SQL)
	if err != nil {
		h.writeError(w, r, http.StatusOK, err.Error())
		return
	}

	writeJSON(w, r, http.StatusOK, executeResponse{
		Success: result.Error == "",
		Result:  result,
		Error:   result.Error,
	})
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
	Segment string             `json:"segment,omitempty"`
	DataDir string             `json:"dataDir,omitempty"`
	Limit   int                `json:"limit"`
	Note    string             `json:"note,omitempty"`
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
		h.writeError(w, r, http.StatusOK, "wal_segments: "+err.Error())
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
	StartXid     uint32                   `json:"startXid"`
	EndXid       uint32                   `json:"endXid"`
	DataDir      string                   `json:"dataDir,omitempty"`
	Note         string                   `json:"note,omitempty"`
}

type clogTransactionResponse struct {
	Xid    uint32 `json:"xid"`
	Status string `json:"status"`
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
		writeJSON(w, r, http.StatusOK, clogResponse{
			Transactions: []clogTransactionResponse{},
			StartXid:     startXid,
			EndXid:       endXid,
			DataDir:      dataDir,
			Note:         err.Error(),
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

	dataDir := h.pgDataDir()
	clogDir := filepath.Join(dataDir, "pg_xact")
	filePath := filepath.Join(clogDir, filename)

	entries, err := readCLOGFile(filePath)
	if err != nil {
		h.writeError(w, r, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, r, http.StatusOK, map[string]any{
		"filename":   filename,
		"path":       filePath,
		"total":      len(entries),
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

	if h.pgClient == nil {
		h.writeError(w, r, http.StatusServiceUnavailable, "no database connection")
		return
	}

	// Query backend processes via Execute (the only public method)
	// Note: PG 18 renamed columns — no "xid" column; use backend_xid, backend_xmin
	rows, err := h.pgClient.Execute(`
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
	lrows, err := h.pgClient.Execute(`
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
	if xid, err := h.pgClient.GetCurrentXid(); err == nil {
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
	mux.HandleFunc("/api/connect", h.ServeConnect)
	mux.HandleFunc("/api/execute", h.ServeExecute)
	mux.HandleFunc("/api/wal", h.ServeWAL)
	mux.HandleFunc("/api/wal/segments", h.ServeWALSegments)
	mux.HandleFunc("/api/clog", h.ServeCLOG)
	mux.HandleFunc("/api/clog/", h.ServeCLOGFile)
	mux.HandleFunc("/api/snapshot", h.ServeSnapshot)
	mux.HandleFunc("/ws", h.ServeWS)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func (h *Handler) pgDataDir() string {
	if h.pgClient != nil {
		if dataDir, err := h.pgClient.GetPGDataDir(); err == nil && dataDir != "" {
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

	// Try pgClient first
	if h.pgClient != nil {
		if xid, err := h.pgClient.GetCurrentXid(); err == nil && xid > 0 {
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
