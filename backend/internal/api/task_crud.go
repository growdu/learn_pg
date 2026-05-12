package api

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
)

// ServeTaskList handles GET /api/tasks.
func (h *Handler) ServeTaskList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		h.writeError(w, r, http.StatusMethodNotAllowed, "GET required")
		return
	}

	limit := 50
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	statusFilter := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("status")))
	taskTypeFilter := strings.TrimSpace(r.URL.Query().Get("taskType"))

	h.taskMu.Lock()
	items := make([]provisionTask, 0, len(h.tasks))
	for _, t := range h.tasks {
		if statusFilter != "" && statusFilter != "all" && t.Status != statusFilter {
			continue
		}
		if taskTypeFilter != "" && t.TaskType != taskTypeFilter {
			continue
		}
		items = append(items, t)
	}
	h.taskMu.Unlock()

	sort.Slice(items, func(i, j int) bool {
		if items[i].StartedAt == items[j].StartedAt {
			return items[i].TaskID > items[j].TaskID
		}
		return items[i].StartedAt > items[j].StartedAt
	})
	if limit > 0 && len(items) > limit {
		items = items[:limit]
	}

	writeJSON(w, r, http.StatusOK, map[string]interface{}{
		"success": true,
		"tasks":   items,
		"count":   len(items),
	})
}

// ServeTaskByID handles GET, DELETE /api/tasks/{id}.
func (h *Handler) ServeTaskByID(w http.ResponseWriter, r *http.Request) {
	taskID := strings.TrimPrefix(r.URL.Path, "/api/tasks/")
	taskID = strings.TrimSpace(taskID)
	if taskID == "" {
		h.writeError(w, r, http.StatusBadRequest, "task id is required")
		return
	}

	switch r.Method {
	case http.MethodGet:
		h.taskMu.Lock()
		task, ok := h.tasks[taskID]
		h.taskMu.Unlock()
		if !ok {
			h.writeError(w, r, http.StatusNotFound, "task not found")
			return
		}
		writeJSON(w, r, http.StatusOK, map[string]interface{}{
			"success": true,
			"task":    task,
		})
		return

	case http.MethodDelete:
		h.taskMu.Lock()
		_, ok := h.tasks[taskID]
		if ok {
			delete(h.tasks, taskID)
			h.persistProvisionTasksLocked()
		}
		h.taskMu.Unlock()
		if !ok {
			h.writeError(w, r, http.StatusNotFound, "task not found")
			return
		}
		writeJSON(w, r, http.StatusOK, map[string]interface{}{
			"success": true,
		})
		return

	default:
		h.writeError(w, r, http.StatusMethodNotAllowed, "GET/DELETE required")
		return
	}
}