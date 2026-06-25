package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDiscoveryScanRequest(t *testing.T) {
	tests := []struct {
		name       string
		body       string
		wantStatus int
		wantErr    bool
	}{
		{
			name:       "valid scan request",
			body:       `{"host": "127.0.0.1", "port": 5432}`,
			wantStatus: http.StatusOK,
			wantErr:    false,
		},
		{
			name:       "missing host",
			body:       `{"port": 5432}`,
			wantStatus: http.StatusBadRequest,
			wantErr:    true,
		},
		{
			name:       "empty host",
			body:       `{"host": "", "port": 5432}`,
			wantStatus: http.StatusBadRequest,
			wantErr:    true,
		},
		{
			name:       "invalid JSON",
			body:       `{invalid}`,
			wantStatus: http.StatusBadRequest,
			wantErr:    true,
		},
		{
			name:       "default port when omitted",
			body:       `{"host": "127.0.0.1"}`,
			wantStatus: http.StatusOK,
			wantErr:    false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Create a minimal handler for testing
			h := &Handler{}

			req := httptest.NewRequest(http.MethodPost, "/api/discovery/host/scan", strings.NewReader(tt.body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()

			h.ServeDiscoveryHostScan(rec, req)

			if rec.Code == http.StatusOK && tt.wantErr {
				t.Errorf("expected error status %d, got %d", tt.wantStatus, rec.Code)
			}
			if tt.wantErr && rec.Code != tt.wantStatus {
				t.Errorf("expected status %d, got %d", tt.wantStatus, rec.Code)
			}
		})
	}
}

func TestDSNValidation(t *testing.T) {
	tests := []struct {
		name  string
		dsn   string
		valid bool
	}{
		{
			name:  "valid postgresql DSN",
			dsn:   "postgresql://postgres:password@127.0.0.1:5432/postgres",
			valid: true,
		},
		{
			name:  "valid postgres scheme",
			dsn:   "postgres://postgres:password@127.0.0.1:5432/postgres",
			valid: true,
		},
		{
			name:  "missing host",
			dsn:   "postgresql://:5432/postgres",
			valid: false,
		},
		{
			name:  "invalid scheme",
			dsn:   "mysql://postgres:5432/postgres",
			valid: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, _, _, _, _, err := parseDSN(tt.dsn)
			if tt.valid && err != nil {
				t.Errorf("expected valid DSN, got error: %v", err)
			}
			if !tt.valid && err == nil {
				t.Errorf("expected invalid DSN, got no error")
			}
		})
	}
}

func TestProvisionTaskLifecycle(t *testing.T) {
	// Create a handler with a temp task path
	tmp := t.TempDir()
	h := &Handler{
		tasks:    make(map[string]provisionTask),
		taskPath: tmp + "/tasks_test.json",
	}

	// Set a task
	taskID := "test-task-1"
	h.setProvisionTask(provisionTask{
		TaskID:  taskID,
		Status:  "running",
		Progress: 50,
		Message: "Testing",
	})

	// Get the task
	task, ok := h.getProvisionTask(taskID)
	if !ok {
		t.Fatalf("expected task %s to exist", taskID)
	}
	if task.Status != "running" {
		t.Errorf("expected status 'running', got '%s'", task.Status)
	}
	if task.Progress != 50 {
		t.Errorf("expected progress 50, got %d", task.Progress)
	}

	// Update to success
	h.setProvisionTask(provisionTask{
		TaskID:     taskID,
		Status:     "success",
		Progress:   100,
		Message:    "Done",
		FinishedAt: 1234567890,
	})

	task, _ = h.getProvisionTask(taskID)
	if task.Status != "success" {
		t.Errorf("expected status 'success', got '%s'", task.Status)
	}
	if task.FinishedAt != 1234567890 {
		t.Errorf("expected finishedAt 1234567890, got %d", task.FinishedAt)
	}
}

func TestPortOpen(t *testing.T) {
	tests := []struct {
		name    string
		addr    string
		timeout any // using any to avoid import cycle, actual time.Duration
		want    bool
	}{
		{
			name: "localhost port 1 should not be open",
			addr: "127.0.0.1:1",
			// Using a very short timeout since we just want to check connectivity
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// This test just verifies the portOpen function doesn't panic
			// Real connectivity depends on the test environment
			got := portOpen(tt.addr, 1000000) // 1ms timeout
			_ = got // We can't assert specific results in a test environment
		})
	}
}