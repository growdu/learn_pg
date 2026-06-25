package connection

import (
	"fmt"
	"sync"
	"sync/atomic"

	"pg-visualizer-backend/internal/config"
	"pg-visualizer-backend/internal/pg"
)

// Manager manages database connections keyed by nodeId.
type Manager struct {
	mu       sync.RWMutex
	conns    map[string]*pg.Client // nodeId -> active connection
	cfgStore map[string]*Config    // nodeId -> connection config for reconnect
	active   atomic.Value          // current active nodeId (stored as string)
	config   *config.Config
}

// Config holds connection parameters for a node.
type Config struct {
	Host     string
	Port     int
	User     string
	Password string
	Database string
}

// NewManager creates a new connection manager.
func NewManager(cfg *config.Config) *Manager {
	return &Manager{
		conns:    make(map[string]*pg.Client),
		cfgStore: make(map[string]*Config),
		config:   cfg,
	}
}

// Register adds or updates connection config for a node (does not connect).
func (m *Manager) Register(nodeId string, cfg Config) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cfgStore[nodeId] = &cfg
}

// Unregister removes config and closes connection for a node.
func (m *Manager) Unregister(nodeId string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	delete(m.cfgStore, nodeId)

	if client, exists := m.conns[nodeId]; exists {
		client.Close()
		delete(m.conns, nodeId)
	}

	if loaded := m.active.Load(); loaded != nil && loaded.(string) == nodeId {
		m.active.Store("")
	}

	return nil
}

// Get returns the connection for a node, or an error if not connected.
func (m *Manager) Get(nodeId string) (*pg.Client, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	client, exists := m.conns[nodeId]
	if !exists {
		return nil, fmt.Errorf("node %s: not connected", nodeId)
	}
	return client, nil
}

// Activate connects a node and sets it as the active node.
func (m *Manager) Activate(nodeId string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	cfg, exists := m.cfgStore[nodeId]
	if !exists {
		return fmt.Errorf("node %s: config not found, call Register first", nodeId)
	}

	client := pg.NewClient()
	if err := client.Connect(cfg.Host, cfg.Port, cfg.User, cfg.Password, cfg.Database); err != nil {
		return fmt.Errorf("node %s: failed to connect: %w", nodeId, err)
	}

	m.conns[nodeId] = client
	m.active.Store(nodeId)

	return nil
}

// Deactivate closes the connection for a node but keeps the config.
func (m *Manager) Deactivate(nodeId string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if client, exists := m.conns[nodeId]; exists {
		client.Close()
		delete(m.conns, nodeId)
	}

	if loaded := m.active.Load(); loaded != nil && loaded.(string) == nodeId {
		m.active.Store("")
	}

	return nil
}

// GetActive returns the active nodeId and its connection.
func (m *Manager) GetActive() (string, *pg.Client) {
	loaded := m.active.Load()
	if loaded == nil {
		return "", nil
	}
	nodeId, ok := loaded.(string)
	if !ok || nodeId == "" {
		return "", nil
	}

	m.mu.RLock()
	defer m.mu.RUnlock()

	client, exists := m.conns[nodeId]
	if !exists {
		return "", nil
	}
	return nodeId, client
}

// Health checks if the node's connection is alive.
func (m *Manager) Health(nodeId string) (bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	client, exists := m.conns[nodeId]
	if !exists {
		return false, fmt.Errorf("node %s: not connected", nodeId)
	}

	if err := client.Ping(); err != nil {
		return false, err
	}
	return true, nil
}

// GetConfig returns the stored config for a node.
func (m *Manager) GetConfig(nodeId string) (Config, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	cfg, exists := m.cfgStore[nodeId]
	if !exists {
		return Config{}, false
	}
	return *cfg, true
}