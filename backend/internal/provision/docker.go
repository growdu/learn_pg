package provision

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// DockerProvider provisions PostgreSQL using docker CLI.
type DockerProvider struct{}

// ID returns "docker".
func (p *DockerProvider) ID() string { return "docker" }

// sanitizeContainerName replaces characters not allowed in Docker container names.
func sanitizeContainerName(name string) string {
	// Docker container names must match [a-zA-Z0-9][a-zA-Z0-9_.-]
	var result []byte
	for _, c := range name {
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '.' || c == '-' {
			result = append(result, byte(c))
		} else {
			result = append(result, '_')
		}
	}
	// Ensure name starts with alphanumeric
	if len(result) == 0 || !((result[0] >= 'a' && result[0] <= 'z') || (result[0] >= 'A' && result[0] <= 'Z') || (result[0] >= '0' && result[0] <= '9')) {
		result = append([]byte("pg"), result...)
	}
	return string(result)
}

// Start starts a PostgreSQL container.
func (p *DockerProvider) Start(ctx context.Context, spec InstanceSpec) (InstanceInfo, error) {
	containerName := fmt.Sprintf("pgv-%s-%d", sanitizeContainerName(spec.Name), time.Now().UnixNano())

	imageName := fmt.Sprintf("docker.m.daocloud.io/library/postgres:%s", spec.PGVersion)

	// Step 1: Ensure image exists locally (skip pull if already cached)
	if hasImage, _ := p.hasLocalImage(imageName); !hasImage {
		pullCtx, pullCancel := context.WithTimeout(ctx, 5*time.Minute)
		defer pullCancel()
		if err := p.runCommand(pullCtx, "docker", "pull", imageName); err != nil {
			return InstanceInfo{}, fmt.Errorf("failed to pull image: %w", err)
		}
	}

	// Step 2: Create volume for data persistence
	volumeName := containerName + "-data"
	if err := p.runCommand(ctx, "docker", "volume", "create", volumeName); err != nil {
		// Volume creation failure is acceptable if volume already exists.
		// Docker run will fail if the volume truly cannot be used, making this non-fatal.
	}

	// Step 3: Find available port (skip if spec.Port is 0)
	port := spec.Port
	if port == 0 {
		port = 5432
	}
	if p.isPortInUse(port) {
		port = p.findAvailablePort(port)
		if port == 0 {
			return InstanceInfo{}, fmt.Errorf("no available port found")
		}
	}

	// Step 4: Run container
	args := []string{
		"run", "-d",
		"--name", containerName,
		"-e", "POSTGRES_PASSWORD=postgres",
		"-e", "POSTGRES_USER=postgres",
		"-p", fmt.Sprintf("%d:5432", port),
		"-v", fmt.Sprintf("%s:/var/lib/postgresql/data", volumeName),
	}
	if spec.Env != nil {
		for k, v := range spec.Env {
			args = append(args, "-e", fmt.Sprintf("%s=%s", k, v))
		}
	}
	args = append(args, fmt.Sprintf("docker.m.daocloud.io/library/postgres:%s", spec.PGVersion))

	if err := p.runCommand(ctx, "docker", args...); err != nil {
		return InstanceInfo{}, fmt.Errorf("failed to create container: %w", err)
	}

	// Step 4: Wait for PostgreSQL to be ready
	if err := p.waitForPostgres(ctx, containerName, port); err != nil {
		p.Stop(ctx, InstanceInfo{ContainerID: containerName, ProviderID: "docker", DataDir: volumeName})
		return InstanceInfo{}, fmt.Errorf("instance not ready: %w", err)
	}

	return InstanceInfo{
		ProviderID:  "docker",
		ContainerID: containerName,
		Host:        "127.0.0.1",
		Port:        port,
		DataDir:     volumeName,
		Name:        spec.Name,
	}, nil
}

// Stop stops and removes a PostgreSQL container.
func (p *DockerProvider) Stop(ctx context.Context, info InstanceInfo) error {
	// Stop container
	_ = p.runCommand(ctx, "docker", "stop", info.ContainerID)
	// Remove container
	_ = p.runCommand(ctx, "docker", "rm", info.ContainerID)
	// Remove volume
	_ = p.runCommand(ctx, "docker", "volume", "rm", info.DataDir)
	return nil
}

// waitForPostgres waits for PostgreSQL to be ready.
func (p *DockerProvider) waitForPostgres(ctx context.Context, containerID string, port int) error {
	maxAttempts := 30
	for i := 0; i < maxAttempts; i++ {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
		buf := &bytes.Buffer{}
		cmd := exec.CommandContext(ctx, "docker", "exec", containerID, "pg_isready", "-h", "127.0.0.1", "-p", "5432")
		cmd.Stdout = buf
		cmd.Stderr = buf
		if err := cmd.Run(); err == nil {
			return nil
		}
	}
	return fmt.Errorf("timeout waiting for PostgreSQL")
}

// runCommand runs a shell command.
func (p *DockerProvider) runCommand(ctx context.Context, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("command failed: %s %v: %w", name, args, err)
	}
	return nil
}

// hasLocalImage checks if image exists locally.
func (p *DockerProvider) hasLocalImage(imageName string) (bool, error) {
	cmd := exec.Command("docker", "image", "inspect", imageName)
	if err := cmd.Run(); err != nil {
		return false, nil // image not found
	}
	return true, nil
}

// isPortInUse checks if a port is already in use.
func (p *DockerProvider) isPortInUse(port int) bool {
	// Check via docker ps first
	cmd := exec.Command("docker", "ps", "--filter", fmt.Sprintf("publish=%d", port), "--format", "{{.Names}}")
	output := &bytes.Buffer{}
	cmd.Stdout = output
	cmd.Run()
	if output.Len() > 0 {
		return true
	}
	// Also check via netstat for non-docker listeners
	cmd2 := exec.Command("netstat", "-tlnp")
	output2 := &bytes.Buffer{}
	cmd2.Stdout = output2
	cmd2.Run()
	return strings.Contains(output2.String(), fmt.Sprintf(":%d", port))
}

// findAvailablePort finds an available port starting from a given port.
func (p *DockerProvider) findAvailablePort(startPort int) int {
	for port := startPort; port < startPort+100; port++ {
		if !p.isPortInUse(port) {
			return port
		}
	}
	return 0
}
