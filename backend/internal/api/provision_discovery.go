package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
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

// ─── Task types & persistence ────────────────────────────────────────────────

type provisionTask struct {
	TaskID     string   `json:"taskId"`
	TaskType   string   `json:"taskType"`   // "provision.single" | "provision.physical" | "provision.logical" | "discovery.scan" | "discovery.import"
	Status     string   `json:"status"`     // "pending" | "running" | "success" | "failed"
	Progress   int      `json:"progress"`   // 0-100
	Message    string   `json:"message,omitempty"`
	Result     string   `json:"result,omitempty"`
	Logs       string   `json:"logs,omitempty"`
	ProjectID  string   `json:"projectId,omitempty"`
	ClusterID  string   `json:"clusterId,omitempty"`
	NodeIDs    []string `json:"nodeIDs,omitempty"`
	Error      string   `json:"error,omitempty"`
	StartedAt  int64    `json:"startedAt,omitempty"`
	FinishedAt int64    `json:"finishedAt,omitempty"`
}

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

// ─── Shared helpers ──────────────────────────────────────────────────────────

func genID(prefix string) string {
	return fmt.Sprintf("%s-%d", prefix, time.Now().UnixNano())
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

func portOpen(addr string, timeout time.Duration) bool {
	conn, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// pgIsReady checks if a PostgreSQL instance is accepting connections using pg_isready.
func pgIsReady(host string, port int) (version string, reachable bool) {
	c := &pg.Client{}
	dbs := []string{"template1", "postgres"}
	for _, db := range dbs {
		if err := c.Connect(host, port, "pgsql", "", db); err == nil {
			reachable = true
			version, _ = c.GetVersion()
			c.Close()
			break
		}
	}
	return version, reachable
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

type pgClientProxy struct{}

func (p *pgClientProxy) connectAndVersion(host string, port int, user, password, db string) (string, error) {
	c := &pg.Client{}
	if err := c.Connect(host, port, user, password, db); err != nil {
		return "", err
	}
	defer c.Close()
	return c.GetVersion()
}
