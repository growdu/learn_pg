package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const currentWorkspaceSchemaVersion = 1

type workspaceNode struct {
	ID           string                 `json:"id"`
	Name         string                 `json:"name"`
	Host         string                 `json:"host"`
	Port         int                    `json:"port"`
	User         string                 `json:"user"`
	Password     string                 `json:"password"`
	Database     string                 `json:"database"`
	ClusterType  string                 `json:"cluster_type"`
	Role         string                 `json:"role"`
	Source       string                 `json:"source,omitempty"`
	DSN          string                 `json:"dsn,omitempty"`
	InstanceMeta *workspaceInstanceMeta `json:"instanceMeta,omitempty"`
	SSHHint      *workspaceSSHHint      `json:"sshHint,omitempty"`
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
	SchemaVersion int                `json:"schemaVersion"`
	Projects      []workspaceProject `json:"projects"`
}

type workspaceStore struct {
	mu   sync.Mutex
	path string
}

func newWorkspaceStore(path string) *workspaceStore {
	return &workspaceStore{path: path}
}

func (s *workspaceStore) readSnapshot() ([]workspaceProject, int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	env, err := s.readEnvelopeLocked()
	if err != nil {
		return nil, 0, err
	}
	return env.Projects, env.SchemaVersion, nil
}

func (s *workspaceStore) readAll() ([]workspaceProject, error) {
	projects, _, err := s.readSnapshot()
	return projects, err
}

func (s *workspaceStore) readEnvelopeLocked() (workspaceEnvelope, error) {
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
