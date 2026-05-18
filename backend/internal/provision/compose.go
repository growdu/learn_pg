package provision

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"text/template"
)

// ComposeGenerator generates Docker Compose configurations for PostgreSQL replication.
type ComposeGenerator struct{}

func NewComposeGenerator() *ComposeGenerator {
	return &ComposeGenerator{}
}

// GeneratePhysicalCompose generates a docker-compose.yml for physical replication (primary + standby).
func (g *ComposeGenerator) GeneratePhysicalCompose() (string, error) {
	const tmpl = `version: "3.8"

services:
  primary:
    image: docker.m.daocloud.io/library/postgres:${PG_VERSION:-16}
    container_name: ${PROJECT_NAME}-primary
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: postgres
    ports:
      - "${PRIMARY_PORT:-5432}:5432"
    volumes:
      - primary_data:/var/lib/postgresql/data
    command:
      - postgres
      - -c
      - wal_level=replica
      - -c
      - max_wal_senders=10
      - -c
      - hot_standby=on
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5

  standby:
    image: docker.m.daocloud.io/library/postgres:${PG_VERSION:-16}
    container_name: ${PROJECT_NAME}-standby
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: postgres
    ports:
      - "${STANDBY_PORT:-5433}:5432"
    volumes:
      - standby_data:/var/lib/postgresql/data
    command:
      - postgres
      - -c
      - hot_standby=on
    depends_on:
      primary:
        condition: service_healthy
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    entrypoint: ["/bin/bash", "-c"]
    command:
      - |
        export PRIMARY_HOST=primary
        rm -rf /var/lib/postgresql/data/*
        chown postgres:postgres /var/lib/postgresql/data
        su postgres -c "pg_basebackup -h $PRIMARY_HOST -U postgres -D /var/lib/postgresql/data -R -P -Xs"
        su postgres -c "postgres -c hot_standby=on"

volumes:
  primary_data:
  standby_data:
`
	t, err := template.New("physical_compose").Parse(tmpl)
	if err != nil {
		return "", fmt.Errorf("failed to parse template: %w", err)
	}

	var buf bytes.Buffer
	data := map[string]string{
		"PG_VERSION":   "16",
		"PROJECT_NAME": "pg replication",
		"PRIMARY_PORT": "5432",
		"STANDBY_PORT": "5433",
	}
	if err := t.Execute(&buf, data); err != nil {
		return "", fmt.Errorf("failed to execute template: %w", err)
	}

	return buf.String(), nil
}

// GenerateLogicalCompose generates a docker-compose.yml for logical replication (publisher + subscriber).
func (g *ComposeGenerator) GenerateLogicalCompose() (string, error) {
	const tmpl = `version: "3.8"

services:
  publisher:
    image: docker.m.daocloud.io/library/postgres:${PG_VERSION:-16}
    container_name: ${PROJECT_NAME}-publisher
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: postgres
    ports:
      - "${PUBLISHER_PORT:-5432}:5432"
    volumes:
      - publisher_data:/var/lib/postgresql/data
    command:
      - postgres
      - -c
      - wal_level=logical
      - -c
      - max_wal_senders=10
      - -c
      - max_replication_slots=10
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5

  subscriber:
    image: docker.m.daocloud.io/library/postgres:${PG_VERSION:-16}
    container_name: ${PROJECT_NAME}-subscriber
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: postgres
    ports:
      - "${SUBSCRIBER_PORT:-5433}:5432"
    volumes:
      - subscriber_data:/var/lib/postgresql/data
    depends_on:
      publisher:
        condition: service_healthy
    command:
      - postgres
      - -c
      - hot_standby=on

volumes:
  publisher_data:
  subscriber_data:
`
	t, err := template.New("logical_compose").Parse(tmpl)
	if err != nil {
		return "", fmt.Errorf("failed to parse template: %w", err)
	}

	var buf bytes.Buffer
	data := map[string]string{
		"PG_VERSION":      "16",
		"PROJECT_NAME":    "pg replication",
		"PUBLISHER_PORT":  "5432",
		"SUBSCRIBER_PORT": "5433",
	}
	if err := t.Execute(&buf, data); err != nil {
		return "", fmt.Errorf("failed to execute template: %w", err)
	}

	return buf.String(), nil
}

// ComposeRunner executes docker compose commands.
type ComposeRunner struct {
	workDir string
}

func NewComposeRunner(workDir string) *ComposeRunner {
	return &ComposeRunner{workDir: workDir}
}

// Up creates and starts containers from a compose file.
func (r *ComposeRunner) Up(ctx context.Context, projectName string, composeContent string) (string, error) {
	composePath := filepath.Join(r.workDir, projectName+".yml")

	// Write compose file
	if err := os.WriteFile(composePath, []byte(composeContent), 0644); err != nil {
		return "", fmt.Errorf("failed to write compose file: %w", err)
	}

	// Execute docker compose up -d
	cmd := exec.CommandContext(ctx, "docker-compose", "-f", composePath, "-p", projectName, "up", "-d")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return stdout.String() + stderr.String(), fmt.Errorf("docker compose up failed: %w", err)
	}

	return stdout.String() + stderr.String(), nil
}

// Down stops and destroys containers.
func (r *ComposeRunner) Down(ctx context.Context, projectName string) (string, error) {
	composePath := filepath.Join(r.workDir, projectName+".yml")

	// Execute docker compose down -v
	cmd := exec.CommandContext(ctx, "docker-compose", "-f", composePath, "-p", projectName, "down", "-v")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return stdout.String() + stderr.String(), fmt.Errorf("docker compose down failed: %w", err)
	}

	return stdout.String() + stderr.String(), nil
}