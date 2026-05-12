package provision

import (
	"context"
	"fmt"
	"sync"
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
	providers   map[string]Provider
	defaultPort  int
	mu           sync.Mutex
}

// NewService creates a new ProvisionService.
func NewService() *Service {
	return &Service{
		providers:  make(map[string]Provider),
		defaultPort: 5432,
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

// StartSingle starts a single-node PostgreSQL instance.
func (s *Service) StartSingle(ctx context.Context, spec InstanceSpec, providerID string) (InstanceInfo, error) {
	if spec.Port == 0 {
		spec.Port = s.findAvailablePort()
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
		return fmt.Errorf("unknown provider: %s", info.ProviderID)
	}
	return p.Stop(ctx, info)
}

func (s *Service) findAvailablePort() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Start from default port and try increasing until available
	port := s.defaultPort
	for i := 0; i < 100; i++ {
		if isPortAvailable(port) {
			s.defaultPort = port + 1
			return port
		}
		port++
	}
	return 0 // no available port found
}

func isPortAvailable(port int) bool {
	// Simple check - in real impl would try to bind
	return true // placeholder
}