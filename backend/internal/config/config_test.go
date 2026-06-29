package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadDefaults(t *testing.T) {
	os.Unsetenv("PG_HOST")
	os.Unsetenv("PG_PORT")
	os.Unsetenv("PG_USER")
	os.Unsetenv("PG_PASSWORD")
	os.Unsetenv("PG_DATABASE")
	os.Unsetenv("PG_DATA_DIR")
	os.Unsetenv("API_PORT")
	os.Unsetenv("COLLECTOR_WS_URL")
	os.Unsetenv("ENABLE_EBPF")
	os.Unsetenv("LOG_LEVEL")

	cfg := Load()

	if cfg.PGHost != "localhost" {
		t.Errorf("expected PGHost 'localhost', got '%s'", cfg.PGHost)
	}
	if cfg.PGPort != 5432 {
		t.Errorf("expected PGPort 5432, got %d", cfg.PGPort)
	}
	if cfg.PGUser != "postgres" {
		t.Errorf("expected PGUser 'postgres', got '%s'", cfg.PGUser)
	}
	if cfg.PGPassword != "postgres" {
		t.Errorf("expected PGPassword 'postgres', got '%s'", cfg.PGPassword)
	}
	if cfg.PGDatabase != "postgres" {
		t.Errorf("expected PGDatabase 'postgres', got '%s'", cfg.PGDatabase)
	}
	if cfg.PGDataDir != "/dev_tool/docker_root/volumes/learn_pg_pg_data/_data/data" {
		t.Errorf("expected PGDataDir '/dev_tool/docker_root/volumes/learn_pg_pg_data/_data/data', got '%s'", cfg.PGDataDir)
	}
	if cfg.APIPort != 3000 {
		t.Errorf("expected APIPort 3000, got %d", cfg.APIPort)
	}
	if cfg.CollectorWSURL != "ws://localhost:8090" {
		t.Errorf("expected CollectorWSURL 'ws://localhost:8090', got '%s'", cfg.CollectorWSURL)
	}
	if cfg.EnableEBPF != true {
		t.Errorf("expected EnableEBPF true, got %v", cfg.EnableEBPF)
	}
	if cfg.LogLevel != "info" {
		t.Errorf("expected LogLevel 'info', got '%s'", cfg.LogLevel)
	}
}

func TestLoadFromEnv(t *testing.T) {
	os.Setenv("PG_HOST", "mypghost")
	os.Setenv("PG_PORT", "5433")
	os.Setenv("PG_USER", "myuser")
	os.Setenv("PG_PASSWORD", "mypass")
	os.Setenv("PG_DATABASE", "mydb")
	os.Setenv("PG_DATA_DIR", "/custom/data")
	os.Setenv("API_PORT", "4000")
	os.Setenv("COLLECTOR_WS_URL", "ws://custom:9999")
	os.Setenv("ENABLE_EBPF", "false")
	os.Setenv("LOG_LEVEL", "debug")
	defer func() {
		os.Unsetenv("PG_HOST")
		os.Unsetenv("PG_PORT")
		os.Unsetenv("PG_USER")
		os.Unsetenv("PG_PASSWORD")
		os.Unsetenv("PG_DATABASE")
		os.Unsetenv("PG_DATA_DIR")
		os.Unsetenv("API_PORT")
		os.Unsetenv("COLLECTOR_WS_URL")
		os.Unsetenv("ENABLE_EBPF")
		os.Unsetenv("LOG_LEVEL")
	}()

	cfg := Load()

	if cfg.PGHost != "mypghost" {
		t.Errorf("expected PGHost 'mypghost', got '%s'", cfg.PGHost)
	}
	if cfg.PGPort != 5433 {
		t.Errorf("expected PGPort 5433, got %d", cfg.PGPort)
	}
	if cfg.PGUser != "myuser" {
		t.Errorf("expected PGUser 'myuser', got '%s'", cfg.PGUser)
	}
	if cfg.PGPassword != "mypass" {
		t.Errorf("expected PGPassword 'mypass', got '%s'", cfg.PGPassword)
	}
	if cfg.PGDatabase != "mydb" {
		t.Errorf("expected PGDatabase 'mydb', got '%s'", cfg.PGDatabase)
	}
	if cfg.PGDataDir != "/custom/data" {
		t.Errorf("expected PGDataDir '/custom/data', got '%s'", cfg.PGDataDir)
	}
	if cfg.APIPort != 4000 {
		t.Errorf("expected APIPort 4000, got %d", cfg.APIPort)
	}
	if cfg.CollectorWSURL != "ws://custom:9999" {
		t.Errorf("expected CollectorWSURL 'ws://custom:9999', got '%s'", cfg.CollectorWSURL)
	}
	if cfg.EnableEBPF != false {
		t.Errorf("expected EnableEBPF false, got %v", cfg.EnableEBPF)
	}
	if cfg.LogLevel != "debug" {
		t.Errorf("expected LogLevel 'debug', got '%s'", cfg.LogLevel)
	}
}

func TestGetEnvBoolCases(t *testing.T) {
	cases := []struct {
		name  string
		value string
		def   bool
		want  bool
	}{
		{"true", "true", true, true},
		{"false", "false", true, false},
		{"1", "1", true, true},
		{"0", "0", true, false},
		{"random", "xyz", true, false},
		{"empty_default_true", "", true, true},
		{"empty_default_false", "", false, false},
	}

	for _, c := range cases {
		if c.value != "" {
			os.Setenv("TEST_BOOL", c.value)
			defer os.Unsetenv("TEST_BOOL")
		} else {
			os.Unsetenv("TEST_BOOL")
		}
		got := getEnvBool("TEST_BOOL", c.def)
		if got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}

func TestGetEnvInt(t *testing.T) {
	os.Setenv("TEST_INT", "8080")
	defer os.Unsetenv("TEST_INT")

	got := getEnvInt("TEST_INT", 3000)
	if got != 8080 {
		t.Errorf("got %d want 8080", got)
	}

	os.Setenv("TEST_INT_INV", "notnum")
	defer os.Unsetenv("TEST_INT_INV")
	got = getEnvInt("TEST_INT_INV", 3000)
	if got != 3000 {
		t.Errorf("invalid int: got %d want default 3000", got)
	}
}

func TestGetEnv(t *testing.T) {
	os.Setenv("TEST_STR", "hello")
	defer os.Unsetenv("TEST_STR")

	got := getEnv("TEST_STR", "default")
	if got != "hello" {
		t.Errorf("got %s want hello", got)
	}

	os.Unsetenv("TEST_MISSING")
	got = getEnv("TEST_MISSING", "fallback")
	if got != "fallback" {
		t.Errorf("got %s want fallback", got)
	}
}

// TestLoad_WorkspaceAndProvisionFilePaths verifies the env-var overrides
// for the workspace JSON and provision task file. Without these the
// backend would only look at CWD-relative paths, breaking any deployment
// that starts the server from a different directory (Docker, systemd
// with WorkingDirectory=, dev shells that `go run` from the repo root).
func TestLoad_WorkspaceAndProvisionFilePaths(t *testing.T) {
	const (
		ws = "/tmp/pgv-test-workspace.json"
		tk = "/tmp/pgv-test-provision.json"
	)
	t.Setenv("WORKSPACE_FILE_PATH", ws)
	t.Setenv("PROVISION_TASK_FILE_PATH", tk)

	cfg := Load()

	if cfg.WorkspaceFilePath != ws {
		t.Errorf("WorkspaceFilePath = %q, want %q", cfg.WorkspaceFilePath, ws)
	}
	if cfg.ProvisionTaskFilePath != tk {
		t.Errorf("ProvisionTaskFilePath = %q, want %q", cfg.ProvisionTaskFilePath, tk)
	}
	// Sanity-check that the env-var name is wired correctly: clearing
	// both should yield the CWD-relative defaults. t.Setenv("X", "")
	// leaves the var present-but-empty, which getEnv treats as
	// "unset", so this is the right shape for the assertion.
	t.Setenv("WORKSPACE_FILE_PATH", "")
	t.Setenv("PROVISION_TASK_FILE_PATH", "")
	cfg = Load()
	if cfg.WorkspaceFilePath == "" {
		t.Errorf("WorkspaceFilePath empty after env-clear; expected CWD-relative default")
	}
	if cfg.ProvisionTaskFilePath == "" {
		t.Errorf("ProvisionTaskFilePath empty after env-clear; expected CWD-relative default")
	}
	// And the defaults should be filenames the rest of the codebase
	// has hard-coded for years.
	if got := filepath.Base(cfg.WorkspaceFilePath); got != "workspace_projects.json" {
		t.Errorf("default WorkspaceFilePath base = %q, want workspace_projects.json", got)
	}
	if got := filepath.Base(cfg.ProvisionTaskFilePath); got != "provision_tasks.json" {
		t.Errorf("default ProvisionTaskFilePath base = %q, want provision_tasks.json", got)
	}
}