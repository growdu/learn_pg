package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const currentWorkspaceSchemaVersion = 2

// maskedPassword is used in API responses so passwords are never exposed to the frontend.
const maskedPassword = "********"

type workspaceNode struct {
	ID                string                 `json:"id"`
	Name              string                 `json:"name"`
	Host              string                 `json:"host"`
	Port              int                    `json:"port"`
	User              string                 `json:"user"`
	Password          string                 `json:"password"`
	Database          string                 `json:"database"`
	ClusterType       string                 `json:"cluster_type"`
	Role              string                 `json:"role"`
	Source            string                 `json:"source,omitempty"`
	DSN               string                 `json:"dsn,omitempty"`
	InstanceMeta      *workspaceInstanceMeta `json:"instanceMeta,omitempty"`
	SSHHint           *workspaceSSHHint      `json:"sshHint,omitempty"`
	ConnectionStatus  string                 `json:"connectionStatus,omitempty"`
	LastError         string                 `json:"lastError,omitempty"`
	HostId            string                 `json:"hostId,omitempty"`
	ContainerID       string                 `json:"containerId,omitempty"`
}

type workspaceCluster struct {
	ID                string            `json:"id"`
	Name              string            `json:"name"`
	ReplicationType   string            `json:"replicationType"`
	AlertThresholdSec int               `json:"alertThresholdSec,omitempty"`
	ProvisionMode     string            `json:"provisionMode,omitempty"`
	ProvisionTaskID   string            `json:"provisionTaskId,omitempty"`
	Runtime           *workspaceRuntime `json:"runtime,omitempty"`
	Nodes             []workspaceNode   `json:"nodes"`
}

type workspaceComponent struct {
	ID               string   `json:"id"`
	Name             string   `json:"name"`
	ComponentType    string   `json:"componentType"`
	LinkedClusterIDs []string `json:"linkedClusterIds"`
}

type workspaceHost struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Host      string `json:"host"`
	Port      int    `json:"port"`
	SSHUser   string `json:"sshUser"`
	SSHKey    string `json:"sshKey,omitempty"`
	CreatedAt int64  `json:"createdAt"`
}

type workspaceProject struct {
	ID         string               `json:"id"`
	Name       string               `json:"name"`
	Clusters   []workspaceCluster   `json:"clusters"`
	Components []workspaceComponent `json:"components"`
}

type workspaceRuntime struct {
	Type      string `json:"type"`
	PGVersion string `json:"pgVersion,omitempty"`
}

type workspaceInstanceMeta struct {
	Service string `json:"service,omitempty"`
	DataDir string `json:"dataDir,omitempty"`
	Version string `json:"version,omitempty"`
}

type workspaceSSHHint struct {
	Host string `json:"host,omitempty"`
	Port int    `json:"port,omitempty"`
	User string `json:"user,omitempty"`
}

type workspaceEnvelope struct {
	SchemaVersion int                  `json:"schemaVersion"`
	Projects      []workspaceProject   `json:"projects"`
	Hosts         []workspaceHost      `json:"hosts"` // added
}

type workspaceStore struct {
	mu   sync.Mutex
	path string
}

func newWorkspaceStore(path string) *workspaceStore {
	return &workspaceStore{path: path}
}

// readEnvelopeNoLock reads the envelope without acquiring lock. Caller must hold s.mu.
func (s *workspaceStore) readEnvelopeNoLock() (workspaceEnvelope, error) {
	b, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return workspaceEnvelope{SchemaVersion: currentWorkspaceSchemaVersion, Projects: []workspaceProject{}}, nil
		}
		return workspaceEnvelope{}, err
	}
	if len(strings.TrimSpace(string(b))) == 0 {
		return workspaceEnvelope{SchemaVersion: currentWorkspaceSchemaVersion, Projects: []workspaceProject{}}, nil
	}

	// 兼容旧格式：顶层是数组
	var legacy []workspaceProject
	if err := json.Unmarshal(b, &legacy); err == nil {
		return workspaceEnvelope{SchemaVersion: 0, Projects: normalizeProjects(legacy)}, nil
	}

	// 新格式：envelope
	var env workspaceEnvelope
	if err := json.Unmarshal(b, &env); err != nil {
		return workspaceEnvelope{}, err
	}
	if env.SchemaVersion <= 0 {
		env.SchemaVersion = currentWorkspaceSchemaVersion
	}
	env.Projects = normalizeProjects(env.Projects)
	return env, nil
}

func (s *workspaceStore) readSnapshot() ([]workspaceProject, int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	env, err := s.readEnvelopeNoLock()
	if err != nil {
		return nil, 0, err
	}
	return env.Projects, env.SchemaVersion, nil
}

func (s *workspaceStore) readAll() ([]workspaceProject, error) {
	projects, _, err := s.readSnapshot()
	return projects, err
}

func (s *workspaceStore) writeAll(projects []workspaceProject) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.writeEnvelopeLocked(workspaceEnvelope{
		SchemaVersion: currentWorkspaceSchemaVersion,
		Projects:      normalizeProjects(projects),
	})
}

func (s *workspaceStore) writeEnvelopeLocked(env workspaceEnvelope) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(env, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func (s *workspaceStore) upsert(p workspaceProject) error {
	items, err := s.readAll()
	if err != nil {
		return err
	}
	if strings.TrimSpace(p.ID) == "" {
		return fmt.Errorf("project id is required")
	}

	replaced := false
	for i := range items {
		if items[i].ID == p.ID {
			items[i] = p
			replaced = true
			break
		}
	}
	if !replaced {
		items = append(items, p)
	}
	return s.writeAll(items)
}

func (s *workspaceStore) deleteByID(id string) error {
	if strings.TrimSpace(id) == "" {
		return fmt.Errorf("project id is required")
	}
	items, err := s.readAll()
	if err != nil {
		return err
	}

	next := make([]workspaceProject, 0, len(items))
	for _, it := range items {
		if it.ID != id {
			next = append(next, it)
		}
	}
	return s.writeAll(next)
}

func (s *workspaceStore) appendCluster(projectID string, cluster workspaceCluster) error {
	if strings.TrimSpace(projectID) == "" {
		return fmt.Errorf("projectId is required")
	}
	items, err := s.readAll()
	if err != nil {
		return err
	}
	for i := range items {
		if items[i].ID == projectID {
			if cluster.ID == "" {
				return fmt.Errorf("cluster id is required")
			}
			cluster.Nodes = normalizeProjects([]workspaceProject{{Clusters: []workspaceCluster{cluster}}})[0].Clusters[0].Nodes
			items[i].Clusters = append(items[i].Clusters, cluster)
			return s.writeAll(items)
		}
	}
	return fmt.Errorf("project not found: %s", projectID)
}

func (s *workspaceStore) appendNode(projectID, clusterID string, node workspaceNode) error {
	if strings.TrimSpace(projectID) == "" || strings.TrimSpace(clusterID) == "" {
		return fmt.Errorf("projectId and clusterId are required")
	}
	items, err := s.readAll()
	if err != nil {
		return err
	}
	for pi := range items {
		if items[pi].ID != projectID {
			continue
		}
		for ci := range items[pi].Clusters {
			if items[pi].Clusters[ci].ID != clusterID {
				continue
			}
			if node.ID == "" {
				return fmt.Errorf("node id is required")
			}
			items[pi].Clusters[ci].Nodes = append(items[pi].Clusters[ci].Nodes, node)
			return s.writeAll(items)
		}
		return fmt.Errorf("cluster not found: %s", clusterID)
	}
	return fmt.Errorf("project not found: %s", projectID)
}

// GetProject returns a single project by ID, or nil if not found.
func (s *workspaceStore) GetProject(id string) (*workspaceProject, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	env, err := s.readEnvelopeNoLock()
	if err != nil {
		return nil, err
	}
	for i := range env.Projects {
		if env.Projects[i].ID == id {
			return &env.Projects[i], nil
		}
	}
	return nil, nil
}

// GetCluster returns a single cluster within a project, or nil if not found.
func (s *workspaceStore) GetCluster(projectID, clusterID string) (*workspaceCluster, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	env, err := s.readEnvelopeNoLock()
	if err != nil {
		return nil, err
	}
	for pi := range env.Projects {
		if env.Projects[pi].ID != projectID {
			continue
		}
		for ci := range env.Projects[pi].Clusters {
			if env.Projects[pi].Clusters[ci].ID == clusterID {
				return &env.Projects[pi].Clusters[ci], nil
			}
		}
		return nil, nil
	}
	return nil, nil
}

// GetNode returns a single node within a project/cluster, or nil if not found.
func (s *workspaceStore) GetNode(projectID, clusterID, nodeID string) (*workspaceNode, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	env, err := s.readEnvelopeNoLock()
	if err != nil {
		return nil, err
	}
	for pi := range env.Projects {
		if env.Projects[pi].ID != projectID {
			continue
		}
		for ci := range env.Projects[pi].Clusters {
			if env.Projects[pi].Clusters[ci].ID != clusterID {
				continue
			}
			for ni := range env.Projects[pi].Clusters[ci].Nodes {
				if env.Projects[pi].Clusters[ci].Nodes[ni].ID == nodeID {
					return &env.Projects[pi].Clusters[ci].Nodes[ni], nil
				}
			}
			return nil, nil
		}
		return nil, nil
	}
	return nil, nil
}

// UpdateProjectLocked updates project fields via patch callback.
func (s *workspaceStore) UpdateProjectLocked(id string, patch func(*workspaceProject) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	env, err := s.readEnvelopeNoLock()
	if err != nil {
		return err
	}
	for i := range env.Projects {
		if env.Projects[i].ID == id {
			if err := patch(&env.Projects[i]); err != nil {
				return err
			}
			return s.writeEnvelopeLocked(env)
		}
	}
	return fmt.Errorf("project not found: %s", id)
}

// DeleteProjectLocked deletes project by ID.
func (s *workspaceStore) DeleteProjectLocked(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	env, err := s.readEnvelopeNoLock()
	if err != nil {
		return err
	}
	next := make([]workspaceProject, 0, len(env.Projects))
	for _, p := range env.Projects {
		if p.ID != id {
			next = append(next, p)
		}
	}
	if len(next) == len(env.Projects) {
		return fmt.Errorf("project not found: %s", id)
	}
	env.Projects = next
	return s.writeEnvelopeLocked(env)
}

// UpdateClusterLocked updates cluster via patch callback.
func (s *workspaceStore) UpdateClusterLocked(projectID, clusterID string, patch func(*workspaceCluster) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	env, err := s.readEnvelopeNoLock()
	if err != nil {
		return err
	}
	for pi := range env.Projects {
		if env.Projects[pi].ID != projectID {
			continue
		}
		for ci := range env.Projects[pi].Clusters {
			if env.Projects[pi].Clusters[ci].ID == clusterID {
				if err := patch(&env.Projects[pi].Clusters[ci]); err != nil {
					return err
				}
				return s.writeEnvelopeLocked(env)
			}
		}
		return fmt.Errorf("cluster not found: %s", clusterID)
	}
	return fmt.Errorf("project not found: %s", projectID)
}

// DeleteClusterLocked deletes cluster from project.
func (s *workspaceStore) DeleteClusterLocked(projectID, clusterID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	env, err := s.readEnvelopeNoLock()
	if err != nil {
		return err
	}
	for pi := range env.Projects {
		if env.Projects[pi].ID != projectID {
			continue
		}
		clusters := env.Projects[pi].Clusters
		for ci := range clusters {
			if clusters[ci].ID == clusterID {
				env.Projects[pi].Clusters = append(clusters[:ci], clusters[ci+1:]...)
				return s.writeEnvelopeLocked(env)
			}
		}
		return fmt.Errorf("cluster not found: %s", clusterID)
	}
	return fmt.Errorf("project not found: %s", projectID)
}

// UpdateNodeLocked updates node via patch callback.
func (s *workspaceStore) UpdateNodeLocked(projectID, clusterID, nodeID string, patch func(*workspaceNode) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	env, err := s.readEnvelopeNoLock()
	if err != nil {
		return err
	}
	for pi := range env.Projects {
		if env.Projects[pi].ID != projectID {
			continue
		}
		for ci := range env.Projects[pi].Clusters {
			if env.Projects[pi].Clusters[ci].ID != clusterID {
				continue
			}
			for ni := range env.Projects[pi].Clusters[ci].Nodes {
				if env.Projects[pi].Clusters[ci].Nodes[ni].ID == nodeID {
					if err := patch(&env.Projects[pi].Clusters[ci].Nodes[ni]); err != nil {
						return err
					}
					return s.writeEnvelopeLocked(env)
				}
			}
			return fmt.Errorf("node not found: %s", nodeID)
		}
		return fmt.Errorf("cluster not found: %s", clusterID)
	}
	return fmt.Errorf("project not found: %s", projectID)
}

// UpdateNodeStatus updates connection status and last error for a node.
func (s *workspaceStore) UpdateNodeStatus(nodeId string, status string, lastError string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	env, err := s.readEnvelopeNoLock()
	if err != nil {
		return err
	}
	for pi := range env.Projects {
		for ci := range env.Projects[pi].Clusters {
			for ni := range env.Projects[pi].Clusters[ci].Nodes {
				if env.Projects[pi].Clusters[ci].Nodes[ni].ID == nodeId {
					env.Projects[pi].Clusters[ci].Nodes[ni].ConnectionStatus = status
					env.Projects[pi].Clusters[ci].Nodes[ni].LastError = lastError
					return s.writeEnvelopeLocked(env)
				}
			}
		}
	}
	return fmt.Errorf("node not found: %s", nodeId)
}

// DeleteNodeLocked deletes node from cluster.
func (s *workspaceStore) DeleteNodeLocked(projectID, clusterID, nodeID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	env, err := s.readEnvelopeNoLock()
	if err != nil {
		return err
	}
	for pi := range env.Projects {
		if env.Projects[pi].ID != projectID {
			continue
		}
		for ci := range env.Projects[pi].Clusters {
			if env.Projects[pi].Clusters[ci].ID != clusterID {
				continue
			}
			nodes := env.Projects[pi].Clusters[ci].Nodes
			for ni := range nodes {
				if nodes[ni].ID == nodeID {
					env.Projects[pi].Clusters[ci].Nodes = append(nodes[:ni], nodes[ni+1:]...)
					return s.writeEnvelopeLocked(env)
				}
			}
			return fmt.Errorf("node not found: %s", nodeID)
		}
		return fmt.Errorf("cluster not found: %s", clusterID)
	}
	return fmt.Errorf("project not found: %s", projectID)
}

// ReadHosts returns all hosts from workspace.
func (s *workspaceStore) ReadHosts() ([]workspaceHost, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	env, err := s.readEnvelopeNoLock()
	if err != nil {
		return nil, err
	}
	return env.Hosts, nil
}

// WriteHosts saves the hosts array to workspace.
func (s *workspaceStore) WriteHosts(hosts []workspaceHost) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	env, err := s.readEnvelopeNoLock()
	if err != nil {
		return err
	}
	env.Hosts = hosts
	return s.writeEnvelopeLocked(env)
}

// AppendHost adds a new host, returns the host with generated ID.
func (s *workspaceStore) AppendHost(host workspaceHost) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	env, err := s.readEnvelopeNoLock()
	if err != nil {
		return err
	}
	if host.ID == "" {
		host.ID = fmt.Sprintf("host-%d", time.Now().UnixNano())
	}
	if host.CreatedAt == 0 {
		host.CreatedAt = time.Now().UnixMilli()
	}
	env.Hosts = append(env.Hosts, host)
	return s.writeEnvelopeLocked(env)
}

// GetHost returns a single host by ID.
func (s *workspaceStore) GetHost(id string) (*workspaceHost, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	env, err := s.readEnvelopeNoLock()
	if err != nil {
		return nil, err
	}
	for i := range env.Hosts {
		if env.Hosts[i].ID == id {
			return &env.Hosts[i], nil
		}
	}
	return nil, nil
}

// UpdateHost updates a host by ID via patch callback.
func (s *workspaceStore) UpdateHost(id string, patch func(*workspaceHost) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	env, err := s.readEnvelopeNoLock()
	if err != nil {
		return err
	}
	for i := range env.Hosts {
		if env.Hosts[i].ID == id {
			if err := patch(&env.Hosts[i]); err != nil {
				return err
			}
			return s.writeEnvelopeLocked(env)
		}
	}
	return fmt.Errorf("host not found: %s", id)
}

// DeleteHost deletes a host by ID.
func (s *workspaceStore) DeleteHost(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	env, err := s.readEnvelopeNoLock()
	if err != nil {
		return err
	}
	for i := range env.Hosts {
		if env.Hosts[i].ID == id {
			env.Hosts = append(env.Hosts[:i], env.Hosts[i+1:]...)
			return s.writeEnvelopeLocked(env)
		}
	}
	return fmt.Errorf("host not found: %s", id)
}

// MaskNode returns a copy of the node with password masked for API responses.
func MaskNode(n workspaceNode) workspaceNode {
	n.Password = maskedPassword
	return n
}

// MaskCluster returns a copy of the cluster with all node passwords masked.
func MaskCluster(c workspaceCluster) workspaceCluster {
	nodes := make([]workspaceNode, len(c.Nodes))
	for i, n := range c.Nodes {
		nodes[i] = MaskNode(n)
	}
	c.Nodes = nodes
	return c
}

func normalizeProjects(projects []workspaceProject) []workspaceProject {
	if projects == nil {
		return []workspaceProject{}
	}
	for pi := range projects {
		if projects[pi].Clusters == nil {
			projects[pi].Clusters = []workspaceCluster{}
		}
		if projects[pi].Components == nil {
			projects[pi].Components = []workspaceComponent{}
		}
		for ci := range projects[pi].Clusters {
			if projects[pi].Clusters[ci].Nodes == nil {
				projects[pi].Clusters[ci].Nodes = []workspaceNode{}
			}
			if projects[pi].Clusters[ci].AlertThresholdSec <= 0 {
				projects[pi].Clusters[ci].AlertThresholdSec = 30
			}
		}
		for mi := range projects[pi].Components {
			if projects[pi].Components[mi].LinkedClusterIDs == nil {
				projects[pi].Components[mi].LinkedClusterIDs = []string{}
			}
		}
	}
	return projects
}