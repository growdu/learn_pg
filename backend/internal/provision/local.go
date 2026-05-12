package provision

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// LocalProvider provisions PostgreSQL using pg_ctl on the local machine.
type LocalProvider struct{}

// ID returns "local".
func (p *LocalProvider) ID() string { return "local" }

// Start starts a local PostgreSQL instance using pg_ctl.
func (p *LocalProvider) Start(ctx context.Context, spec InstanceSpec) (InstanceInfo, error) {
	if spec.DataDir == "" {
		spec.DataDir = filepath.Join("/var/lib/pgv", spec.Name+"-"+fmt.Sprintf("%d", time.Now().UnixNano()))
	}

	// Step 1: Create data directory
	if err := os.MkdirAll(spec.DataDir, 0755); err != nil {
		return InstanceInfo{}, fmt.Errorf("failed to create data dir: %w", err)
	}

	// Step 2: Check if already initialized (has PG_VERSION file)
	pgVersionFile := filepath.Join(spec.DataDir, "PG_VERSION")
	if _, err := os.Stat(pgVersionFile); os.IsNotExist(err) {
		// Step 3: Initdb if not initialized
		if err := p.runCommand(ctx, "pg_ctl", "initdb", "-D", spec.DataDir); err != nil {
			return InstanceInfo{}, fmt.Errorf("failed to initdb: %w", err)
		}
	} else if err != nil {
		return InstanceInfo{}, fmt.Errorf("failed to check data dir: %w", err)
	}

	// Step 4: Start PostgreSQL
	logFile := filepath.Join(spec.DataDir, "postgres.log")
	args := []string{
		"pg_ctl", "start",
		"-D", spec.DataDir,
		"-l", logFile,
		"-o", fmt.Sprintf("-p %d", spec.Port),
	}
	if err := p.runCommand(ctx, "sh", "-c", strings.Join(args, " ")); err != nil {
		return InstanceInfo{}, fmt.Errorf("failed to start PostgreSQL: %w", err)
	}

	// Step 5: Wait for PostgreSQL to be ready
	if err := p.waitForPostgres(ctx, spec.Port); err != nil {
		p.Stop(ctx, InstanceInfo{ProviderID: "local", DataDir: spec.DataDir})
		return InstanceInfo{}, fmt.Errorf("instance not ready: %w", err)
	}

	return InstanceInfo{
		ProviderID:  "local",
		ContainerID: fmt.Sprintf("%d", os.Getpid()), // placeholder - local doesn't have container ID
		Host:        "127.0.0.1",
		Port:        spec.Port,
		DataDir:     spec.DataDir,
		Name:        spec.Name,
	}, nil
}

// Stop stops the local PostgreSQL instance.
func (p *LocalProvider) Stop(ctx context.Context, info InstanceInfo) error {
	// Stop PostgreSQL
	_ = p.runCommand(ctx, "pg_ctl", "stop", "-D", info.DataDir)
	// Remove data directory
	os.RemoveAll(info.DataDir)
	return nil
}

// waitForPostgres waits for PostgreSQL to be ready.
func (p *LocalProvider) waitForPostgres(ctx context.Context, port int) error {
	maxAttempts := 30
	for i := 0; i < maxAttempts; i++ {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}

		buf := &bytes.Buffer{}
		cmd := exec.CommandContext(ctx, "pg_isready", "-h", "127.0.0.1", "-p", fmt.Sprintf("%d", port))
		cmd.Stdout = buf
		cmd.Stderr = buf
		if err := cmd.Run(); err == nil {
			return nil
		}
	}
	return fmt.Errorf("timeout waiting for PostgreSQL on port %d", port)
}

// runCommand runs a shell command.
func (p *LocalProvider) runCommand(ctx context.Context, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("command failed: %s %v: %w", name, args, err)
	}
	return nil
}