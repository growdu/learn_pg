package provision

import (
	"context"
	"fmt"
	"net"
	"sync"
	"time"
)

// InstanceSpec defines the specification for a PostgreSQL instance.
type InstanceSpec struct {
	Name      string
	PGVersion string // "18", "16", etc.
	Port      int
	DataDir   string
	Env       map[string]string
}

// InstanceInfo contains the runtime information of a started instance.
type InstanceInfo struct {
	ProviderID  string // "docker" | "local"
	ContainerID string // container ID or PID
	Host        string
	Port        int
	DataDir     string
	Name        string
}

// Provider starts and stops PostgreSQL instances.
type Provider interface {
	Start(ctx context.Context, spec InstanceSpec) (InstanceInfo, error)
	Stop(ctx context.Context, info InstanceInfo) error
	ID() string
}

// ReplicationSpec defines the specification for primary/standby or logical replication.
type ReplicationSpec struct {
	Name         string
	Type         string // "physical" | "logical"
	PGVersion    string // "18", "16"
	PrimaryPort  int
	SecondaryPort int
	ProviderID   string
}

// ReplicaInfo contains the runtime information of a started replica.
type ReplicaInfo struct {
	ProviderID     string
	ComposeProject string // docker compose project name
	PrimaryInfo    InstanceInfo
	SecondaryInfo  InstanceInfo
	LAG            string // replication lag
}

// ReplicationStatus represents the status of replication.
type ReplicationStatus struct {
	PrimaryConnected    bool
	SecondaryConnected  bool
	ReplicationWorking bool
	LAG                 string
	LastHeartbeat       int64
}

// ReplicationProvider extends Provider to support replication.
type ReplicationProvider interface {
	Provider
	StartReplica(ctx context.Context, spec ReplicationSpec, primaryInfo InstanceInfo) (ReplicaInfo, error)
	StopReplica(ctx context.Context, replicaInfo ReplicaInfo) error
	GetReplicationStatus(ctx context.Context, replicaInfo ReplicaInfo) (ReplicationStatus, error)
}

// ErrProviderUnavailable is returned when the provider is not available.
type ErrProviderUnavailable struct {
	Provider string
	Reason   string
}

func (e *ErrProviderUnavailable) Error() string {
	return fmt.Sprintf("%s provider unavailable: %s", e.Provider, e.Reason)
}

// ErrPortConflict is returned when the port is already in use.
type ErrPortConflict struct {
	Port int
}

func (e *ErrPortConflict) Error() string {
	return fmt.Sprintf("port %d is already in use", e.Port)
}

// Service manages provisioning of PostgreSQL instances.
type Service struct {
	providers            map[string]Provider
	replicationProviders map[string]ReplicationProvider
	defaultPort          int
	mu                   sync.Mutex
}

// NewService creates a new ProvisionService.
func NewService() *Service {
	return &Service{
		providers:            make(map[string]Provider),
		replicationProviders: make(map[string]ReplicationProvider),
		defaultPort:          5432,
	}
}

// RegisterProvider registers a provider by ID.
func (s *Service) RegisterProvider(p Provider) {
	s.providers[p.ID()] = p
}

// GetProvider returns a provider by ID.
func (s *Service) GetProvider(id string) (Provider, bool) {
	p, ok := s.providers[id]
	return p, ok
}

// RegisterReplicationProvider registers a replication provider by ID.
func (s *Service) RegisterReplicationProvider(p ReplicationProvider) {
	s.replicationProviders[p.ID()] = p
}

// GetReplicationProvider returns a replication provider by ID.
func (s *Service) GetReplicationProvider(id string) (ReplicationProvider, bool) {
	p, ok := s.replicationProviders[id]
	return p, ok
}

// StartSingle starts a single-node PostgreSQL instance.
func (s *Service) StartSingle(ctx context.Context, spec InstanceSpec, providerID string) (InstanceInfo, error) {
	if spec.Port == 0 {
		port, err := s.findAvailablePort()
		if err != nil {
			return InstanceInfo{}, err
		}
		spec.Port = port
	}

	p, ok := s.providers[providerID]
	if !ok {
		return InstanceInfo{}, &ErrProviderUnavailable{Provider: providerID, Reason: "not registered"}
	}

	info, err := p.Start(ctx, spec)
	if err != nil {
		return InstanceInfo{}, err
	}
	return info, nil
}

// StopInstance stops a running instance.
func (s *Service) StopInstance(ctx context.Context, info InstanceInfo) error {
	p, ok := s.providers[info.ProviderID]
	if !ok {
		return &ErrProviderUnavailable{Provider: info.ProviderID, Reason: "not registered"}
	}
	return p.Stop(ctx, info)
}

func (s *Service) findAvailablePort() (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Start from default port and try increasing until available
	port := s.defaultPort
	for i := 0; i < 100; i++ {
		if isPortAvailable(port) {
			s.defaultPort = port + 1
			return port, nil
		}
		port++
	}
	return 0, &ErrPortConflict{Port: 0} // no available port found
}

func isPortAvailable(port int) bool {
	// Simple check - in real impl would try to bind
	return true // placeholder
}

// waitForPostgres waits for PostgreSQL to be ready at the given host:port.
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