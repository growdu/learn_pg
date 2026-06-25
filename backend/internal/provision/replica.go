package provision

import (
	"context"
	"fmt"
	"net"
	"strconv"
	"time"
)

// DockerReplicationProvider provisions PostgreSQL replication using Docker Compose.
type DockerReplicationProvider struct {
	composeGenerator *ComposeGenerator
	composeRunner    *ComposeRunner
	workDir          string
}

// NewDockerReplicationProvider creates a new DockerReplicationProvider.
func NewDockerReplicationProvider(workDir string) *DockerReplicationProvider {
	return &DockerReplicationProvider{
		composeGenerator: NewComposeGenerator(),
		composeRunner:    NewComposeRunner(workDir),
		workDir:          workDir,
	}
}

// ID returns "docker-replication".
func (p *DockerReplicationProvider) ID() string {
	return "docker-replication"
}

// Start implements Provider but is not used for replication clusters.
func (p *DockerReplicationProvider) Start(ctx context.Context, spec InstanceSpec) (InstanceInfo, error) {
	return InstanceInfo{}, fmt.Errorf("use StartReplica for replication clusters")
}

// Stop implements Provider but is not used for replication clusters.
func (p *DockerReplicationProvider) Stop(ctx context.Context, info InstanceInfo) error {
	return fmt.Errorf("use StopReplica for replication clusters")
}

// StartReplica starts a primary/standby or logical replication cluster.
func (p *DockerReplicationProvider) StartReplica(ctx context.Context, spec ReplicationSpec, primaryInfo InstanceInfo) (ReplicaInfo, error) {
	// Generate project name: pgv-replica-{spec.Name}-{unix timestamp}
	projectName := fmt.Sprintf("pgv-replica-%s-%d", spec.Name, time.Now().Unix())

	// Generate compose content based on spec type
	var composeContent string
	var err error
	if spec.Type == "physical" {
		composeContent, err = p.composeGenerator.GeneratePhysicalCompose()
	} else {
		composeContent, err = p.composeGenerator.GenerateLogicalCompose()
	}
	if err != nil {
		return ReplicaInfo{}, fmt.Errorf("failed to generate compose: %w", err)
	}

	// Start containers
	if _, err := p.composeRunner.Up(ctx, projectName, composeContent); err != nil {
		return ReplicaInfo{}, fmt.Errorf("failed to start replica: %w", err)
	}

	// Wait for secondary to be ready
	secondaryHost := "127.0.0.1"
	secondaryPort := spec.SecondaryPort
	if secondaryPort == 0 {
		if spec.Type == "physical" {
			secondaryPort = 5433 // default standby port
		} else {
			secondaryPort = 5433 // default subscriber port
		}
	}

	if err := waitForPostgres(ctx, secondaryHost, secondaryPort); err != nil {
		// Cleanup on failure
		_, cleanupErr := p.composeRunner.Down(ctx, projectName)
		_ = cleanupErr // ignore cleanup error
		return ReplicaInfo{}, fmt.Errorf("secondary not ready: %w", err)
	}

	return ReplicaInfo{
		ProviderID:     p.ID(),
		ComposeProject: projectName,
		PrimaryInfo:    primaryInfo,
		SecondaryInfo: InstanceInfo{
			ProviderID:  p.ID(),
			ContainerID: projectName + "-standby", // or subscriber for logical
			Host:        secondaryHost,
			Port:        secondaryPort,
			Name:        spec.Name + "-secondary",
		},
	}, nil
}

// StopReplica stops the replication cluster.
func (p *DockerReplicationProvider) StopReplica(ctx context.Context, replicaInfo ReplicaInfo) error {
	_, err := p.composeRunner.Down(ctx, replicaInfo.ComposeProject)
	return err
}

// GetReplicationStatus returns the current replication status.
func (p *DockerReplicationProvider) GetReplicationStatus(ctx context.Context, replicaInfo ReplicaInfo) (ReplicationStatus, error) {
	// Check if secondary is reachable via TCP
	secondaryAddr := net.JoinHostPort(replicaInfo.SecondaryInfo.Host, strconv.Itoa(replicaInfo.SecondaryInfo.Port))
	conn, err := net.DialTimeout("tcp", secondaryAddr, 2*time.Second)
	if err != nil {
		return ReplicationStatus{
			PrimaryConnected:   true,
			SecondaryConnected: false,
			ReplicationWorking: false,
			LAG:                "unknown",
			LastHeartbeat:      time.Now().Unix(),
		}, nil
	}
	conn.Close()

	return ReplicationStatus{
		PrimaryConnected:   true,
		SecondaryConnected: true,
		ReplicationWorking: true,
		LAG:                replicaInfo.LAG,
		LastHeartbeat:      time.Now().Unix(),
	}, nil
}