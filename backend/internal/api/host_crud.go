package api

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

func hostIDFromPath(path string) string {
	parts := strings.TrimPrefix(path, "/api/hosts/")
	i := strings.Index(parts, "/")
	if i >= 0 {
		return parts[:i]
	}
	return strings.TrimSpace(parts)
}

// ServeHostList handles GET /api/hosts (list) and POST /api/hosts (create).
func (h *Handler) ServeHostList(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		hosts, err := h.workspace.ReadHosts()
		if err != nil {
			h.writeError(w, r, http.StatusInternalServerError, "failed to read hosts: "+err.Error())
			return
		}
		if hosts == nil {
			hosts = []workspaceHost{}
		}
		writeJSON(w, r, http.StatusOK, map[string]interface{}{
			"success": true,
			"hosts":   hosts,
		})
		return

	case http.MethodPost:
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64*1024))
		if err != nil {
			h.writeError(w, r, http.StatusBadRequest, "failed to read body")
			return
		}
		defer r.Body.Close()

		var req struct {
			Name    string `json:"name"`
			Host    string `json:"host"`
			Port    int    `json:"port"`
			SSHUser string `json:"sshUser"`
			SSHKey  string `json:"sshKey,omitempty"`
		}
		if err := json.Unmarshal(body, &req); err != nil {
			h.writeError(w, r, http.StatusBadRequest, "invalid JSON")
			return
		}
		if strings.TrimSpace(req.Name) == "" {
			h.writeError(w, r, http.StatusBadRequest, "name is required")
			return
		}
	if strings.TrimSpace(req.Host) == "" {
		h.writeError(w, r, http.StatusBadRequest, "host is required")
		return
	}
	port := orDefaultInt(req.Port, 22)
	if port < 1 || port > 65535 {
		h.writeError(w, r, http.StatusBadRequest, "port must be between 1 and 65535")
		return
	}

	host := workspaceHost{
			ID:        "", // will be generated
			Name:      req.Name,
			Host:      req.Host,
			Port:      port,
			SSHUser:   orDefaultStr(req.SSHUser, "root"),
			SSHKey:    req.SSHKey,
			CreatedAt: time.Now().UnixMilli(),
		}

		if err := h.workspace.AppendHost(host); err != nil {
			h.writeError(w, r, http.StatusInternalServerError, err.Error())
			return
		}
		// Re-fetch with generated ID
		hosts, err := h.workspace.ReadHosts()
		if err != nil {
			h.writeError(w, r, http.StatusInternalServerError, "failed to re-fetch host after creation: "+err.Error())
			return
		}
		var saved workspaceHost
		found := false
		for _, h2 := range hosts {
			if h2.Host == host.Host && h2.Name == host.Name {
				saved = h2
				found = true
				break
			}
		}
		if !found {
			h.writeError(w, r, http.StatusInternalServerError, "host created but not found in re-fetch")
			return
		}
		writeJSON(w, r, http.StatusCreated, map[string]interface{}{
			"success": true,
			"host":    saved,
		})
		return

	default:
		h.writeError(w, r, http.StatusMethodNotAllowed, "GET/POST required")
		return
	}
}

// ServeHostByID handles GET, PUT, DELETE /api/hosts/{id}.
func (h *Handler) ServeHostByID(w http.ResponseWriter, r *http.Request) {
	id := hostIDFromPath(r.URL.Path)
	if id == "" {
		h.writeError(w, r, http.StatusBadRequest, "host id is required")
		return
	}

	switch r.Method {
	case http.MethodGet:
		host, err := h.workspace.GetHost(id)
		if err != nil {
			h.writeError(w, r, http.StatusInternalServerError, "failed to get host: "+err.Error())
			return
		}
		if host == nil {
			h.writeError(w, r, http.StatusNotFound, "host not found")
			return
		}
		writeJSON(w, r, http.StatusOK, map[string]interface{}{
			"success": true,
			"host":    *host,
		})
		return

	case http.MethodPut:
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64*1024))
		if err != nil {
			h.writeError(w, r, http.StatusBadRequest, "failed to read body")
			return
		}
		defer r.Body.Close()

		var req struct {
			Name    *string `json:"name,omitempty"`
			Host    *string `json:"host,omitempty"`
			Port    *int    `json:"port,omitempty"`
			SSHUser *string `json:"sshUser,omitempty"`
			SSHKey  *string `json:"sshKey,omitempty"`
		}
		if err := json.Unmarshal(body, &req); err != nil {
			h.writeError(w, r, http.StatusBadRequest, "invalid JSON")
			return
		}

		err = h.workspace.UpdateHost(id, func(h2 *workspaceHost) error {
			if req.Name != nil {
				h2.Name = *req.Name
			}
			if req.Host != nil {
				h2.Host = *req.Host
			}
			if req.Port != nil {
				if *req.Port < 1 || *req.Port > 65535 {
					h.writeError(w, r, http.StatusBadRequest, "port must be between 1 and 65535")
					return
				}
				h2.Port = *req.Port
			}
			if req.SSHUser != nil {
				h2.SSHUser = *req.SSHUser
			}
			if req.SSHKey != nil {
				h2.SSHKey = *req.SSHKey
			}
			return nil
		})
		if err != nil {
			h.writeError(w, r, http.StatusNotFound, err.Error())
			return
		}
		updated, err := h.workspace.GetHost(id)
		if err != nil {
			h.writeError(w, r, http.StatusInternalServerError, "failed to re-fetch host after update: "+err.Error())
			return
		}
		if updated == nil {
			h.writeError(w, r, http.StatusNotFound, "host not found after update")
			return
		}
		writeJSON(w, r, http.StatusOK, map[string]interface{}{
			"success": true,
			"host":    updated,
		})
		return

	case http.MethodDelete:
		if err := h.workspace.DeleteHost(id); err != nil {
			h.writeError(w, r, http.StatusNotFound, err.Error())
			return
		}
		writeJSON(w, r, http.StatusOK, map[string]interface{}{
			"success": true,
		})
		return

	default:
		h.writeError(w, r, http.StatusMethodNotAllowed, "GET/PUT/DELETE required")
		return
	}
}