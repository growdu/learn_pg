package provision

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"time"
)

// DockerProvider provisions PostgreSQL using docker CLI.
type DockerProvider struct{}

// ID returns "docker".
func (p *DockerProvider) ID() string { return "docker" }

// Start starts a PostgreSQL container.
func (p *DockerProvider) Start(ctx context.Context, spec InstanceSpec) (InstanceInfo, error) {
	containerName := fmt.Sprintf("pgv-%s-%d", spec.Name, time.Now().UnixNano())

	pullCtx, pullCancel := context.WithTimeout(ctx, 5*time.Minute)
	defer pullCancel()

	// Step 1: Pull image
	if err := p.runCommand(pullCtx, "docker", "pull", fmt.Sprintf("postgres:%s", spec.PGVersion)); err != nil {
		return InstanceInfo{}, fmt.Errorf("failed to pull image: %w", err)
	}

	// Step 2: Create volume for data persistence
	volumeName := containerName + "-data"
	if err := p.runCommand(ctx, "docker", "volume", "create", volumeName); err != nil {
		// Volume creation failure is acceptable if volume already exists.
		// Docker run will fail if the volume truly cannot be used, making this non-fatal.
	}

	// Step 3: Run container
	args := []string{
		"run", "-d",
		"--name", containerName,
		"-e", "POSTGRES_PASSWORD=postgres",
		"-e", "POSTGRES_USER=postgres",
		"-p", fmt.Sprintf("%d:5432", spec.Port),
		"-v", fmt.Sprintf("%s:/var/lib/postgresql/data", volumeName),
	}
	if spec.Env != nil {
		for k, v := range spec.Env {
			args = append(args, "-e", fmt.Sprintf("%s=%s", k, v))
		}
	}
	args = append(args, fmt.Sprintf("postgres:%s", spec.PGVersion))

	if err := p.runCommand(ctx, "docker", args...); err != nil {
		return InstanceInfo{}, fmt.Errorf("failed to create container: %w", err)
	}

	// Step 4: Wait for PostgreSQL to be ready
	if err := p.waitForPostgres(ctx, containerName, spec.Port); err != nil {
		p.Stop(ctx, InstanceInfo{ContainerID: containerName, ProviderID: "docker", DataDir: volumeName})
		return InstanceInfo{}, fmt.Errorf("instance not ready: %w", err)
	}

	return InstanceInfo{
		ProviderID:  "docker",
		ContainerID: containerName,
		Host:        "127.0.0.1",
		Port:        spec.Port,
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
