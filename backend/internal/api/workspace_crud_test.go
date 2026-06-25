package api

import (
	"os"
	"path/filepath"
	"testing"
)

// mockWorkspaceStore wraps a workspaceStore with a temp file for testing.
func withTestStore(t *testing.T, fn func(*workspaceStore)) {
	tmp := t.TempDir()
	store := &workspaceStore{path: filepath.Join(tmp, "workspace_test.json")}
	// Initialize empty file
	if err := os.WriteFile(store.path, []byte(`{"projects":[],"schemaVersion":2}`), 0644); err != nil {
		t.Fatalf("failed to init test store: %v", err)
	}
	fn(store)
}

func TestWorkspaceReadWrite(t *testing.T) {
	withTestStore(t, func(store *workspaceStore) {
		// Initial read should be empty
		projects, _, err := store.readSnapshot()
		if err != nil {
			t.Fatalf("readSnapshot failed: %v", err)
		}
		if len(projects) != 0 {
			t.Errorf("expected 0 projects, got %d", len(projects))
		}

		// Upsert a project
		proj := workspaceProject{
			ID:       "test-project-1",
			Name:     "Test Project",
			Clusters: []workspaceCluster{},
		}
		if err := store.upsert(proj); err != nil {
			t.Fatalf("upsert failed: %v", err)
		}

		// Re-read should contain the project
		projects, _, err = store.readSnapshot()
		if err != nil {
			t.Fatalf("readSnapshot after upsert failed: %v", err)
		}
		if len(projects) != 1 {
			t.Errorf("expected 1 project, got %d", len(projects))
		}
		if projects[0].Name != "Test Project" {
			t.Errorf("expected project name 'Test Project', got '%s'", projects[0].Name)
		}
	})
}

func TestWorkspaceAppendCluster(t *testing.T) {
	withTestStore(t, func(store *workspaceStore) {
		// Create a project first
		proj := workspaceProject{ID: "proj-1", Name: "P1", Clusters: []workspaceCluster{}}
		if err := store.upsert(proj); err != nil {
			t.Fatalf("upsert failed: %v", err)
		}

		// Append a cluster
		cluster := workspaceCluster{ID: "cluster-1", Name: "C1", ReplicationType: "physical", Nodes: []workspaceNode{}}
		if err := store.appendCluster("proj-1", cluster); err != nil {
			t.Fatalf("appendCluster failed: %v", err)
		}

		// Verify cluster is attached
		projects, _, _ := store.readSnapshot()
		if len(projects[0].Clusters) != 1 {
			t.Errorf("expected 1 cluster, got %d", len(projects[0].Clusters))
		}
		if projects[0].Clusters[0].Name != "C1" {
			t.Errorf("expected cluster name 'C1', got '%s'", projects[0].Clusters[0].Name)
		}
	})
}

func TestWorkspaceAppendNode(t *testing.T) {
	withTestStore(t, func(store *workspaceStore) {
		proj := workspaceProject{ID: "proj-1", Name: "P1", Clusters: []workspaceCluster{
			{ID: "cluster-1", Name: "C1", ReplicationType: "physical", Nodes: []workspaceNode{}},
		}}
		if err := store.upsert(proj); err != nil {
			t.Fatalf("upsert failed: %v", err)
		}

		node := workspaceNode{ID: "node-1", Name: "N1", Host: "127.0.0.1", Port: 5432}
		if err := store.appendNode("proj-1", "cluster-1", node); err != nil {
			t.Fatalf("appendNode failed: %v", err)
		}

		projects, _, _ := store.readSnapshot()
		if len(projects[0].Clusters[0].Nodes) != 1 {
			t.Errorf("expected 1 node, got %d", len(projects[0].Clusters[0].Nodes))
		}
	})
}

func TestWorkspaceDeleteByID(t *testing.T) {
	withTestStore(t, func(store *workspaceStore) {
		proj := workspaceProject{ID: "proj-to-delete", Name: "Delete Me", Clusters: []workspaceCluster{}}
		if err := store.upsert(proj); err != nil {
			t.Fatalf("upsert failed: %v", err)
		}

		if err := store.deleteByID("proj-to-delete"); err != nil {
			t.Fatalf("deleteByID failed: %v", err)
		}

		projects, _, _ := store.readSnapshot()
		if len(projects) != 0 {
			t.Errorf("expected 0 projects after delete, got %d", len(projects))
		}
	})
}

func TestWorkspaceUpdateHost(t *testing.T) {
	withTestStore(t, func(store *workspaceStore) {
		host := workspaceHost{ID: "host-1", Name: "Original", Host: "192.168.1.1", Port: 22, SSHUser: "root"}
		if err := store.AppendHost(host); err != nil {
			t.Fatalf("AppendHost failed: %v", err)
		}

		// Update the host name
		err := store.UpdateHost("host-1", func(h *workspaceHost) error {
			h.Name = "Updated"
			return nil
		})
		if err != nil {
			t.Fatalf("UpdateHost failed: %v", err)
		}

		// Verify update
		updated, err := store.GetHost("host-1")
		if err != nil {
			t.Fatalf("GetHost failed: %v", err)
		}
		if updated == nil || updated.Name != "Updated" {
			t.Errorf("expected host name 'Updated', got '%v'", updated)
		}
	})
}

func TestWorkspaceHostsCRUD(t *testing.T) {
	withTestStore(t, func(store *workspaceStore) {
		// Create
		host := workspaceHost{ID: "host-crud", Name: "CRUD Host", Host: "10.0.0.1", Port: 22, SSHUser: "admin"}
		if err := store.AppendHost(host); err != nil {
			t.Fatalf("AppendHost failed: %v", err)
		}

		// Read
		hosts, err := store.ReadHosts()
		if err != nil {
			t.Fatalf("ReadHosts failed: %v", err)
		}
		if len(hosts) != 1 {
			t.Errorf("expected 1 host, got %d", len(hosts))
		}

		// Delete
		if err := store.DeleteHost("host-crud"); err != nil {
			t.Fatalf("DeleteHost failed: %v", err)
		}
		hosts, _ = store.ReadHosts()
		if len(hosts) != 0 {
			t.Errorf("expected 0 hosts after delete, got %d", len(hosts))
		}
	})
}