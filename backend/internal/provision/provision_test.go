package provision

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
)

// mockProvider is a deterministic test double for Provider. It records
// what Start/Stop were called with and returns whatever the test sets
// on the response fields.
type mockProvider struct {
	id           string
	startCalls   []InstanceSpec
	stopCalls    []InstanceInfo
	startInfo    InstanceInfo
	startErr     error
	stopErr      error
	replicaCalls []struct {
		spec   ReplicationSpec
		pri    InstanceInfo
		result ReplicaInfo
		err    error
	}
	replicaStops     []ReplicaInfo
	replicaStopErr   error
	replicaStatus    ReplicationStatus
	replicaStatusErr error
}

func (m *mockProvider) ID() string { return m.id }

func (m *mockProvider) Start(_ context.Context, spec InstanceSpec) (InstanceInfo, error) {
	m.startCalls = append(m.startCalls, spec)
	return m.startInfo, m.startErr
}

func (m *mockProvider) Stop(_ context.Context, info InstanceInfo) error {
	m.stopCalls = append(m.stopCalls, info)
	return m.stopErr
}

func (m *mockProvider) StartReplica(_ context.Context, spec ReplicationSpec, pri InstanceInfo) (ReplicaInfo, error) {
	m.replicaCalls = append(m.replicaCalls, struct {
		spec   ReplicationSpec
		pri    InstanceInfo
		result ReplicaInfo
		err    error
	}{spec, pri, ReplicaInfo{}, nil})
	rec := m.replicaCalls[len(m.replicaCalls)-1]
	return rec.result, rec.err
}

func (m *mockProvider) StopReplica(_ context.Context, info ReplicaInfo) error {
	m.replicaStops = append(m.replicaStops, info)
	return m.replicaStopErr
}

func (m *mockProvider) GetReplicationStatus(_ context.Context, _ ReplicaInfo) (ReplicationStatus, error) {
	return m.replicaStatus, m.replicaStatusErr
}

// ---------- Service: provider registry ----------

func TestService_RegisterAndGetProvider(t *testing.T) {
	s := NewService()
	p := &mockProvider{id: "mock"}
	s.RegisterProvider(p)

	got, ok := s.GetProvider("mock")
	if !ok {
		t.Fatal("expected provider to be registered")
	}
	if got.ID() != "mock" {
		t.Errorf("got provider ID %q, want 'mock'", got.ID())
	}
}

func TestService_GetProviderMissing(t *testing.T) {
	s := NewService()
	if _, ok := s.GetProvider("nope"); ok {
		t.Error("expected GetProvider to return false for unknown id")
	}
}

func TestService_RegisterReplicationProvider(t *testing.T) {
	s := NewService()
	p := &mockProvider{id: "rp"}
	s.RegisterReplicationProvider(p)

	got, ok := s.GetReplicationProvider("rp")
	if !ok {
		t.Fatal("expected replication provider to be registered")
	}
	if got.ID() != "rp" {
		t.Errorf("got ID %q, want 'rp'", got.ID())
	}
}

// ---------- Service: StartSingle ----------

func TestService_StartSingle_UnknownProvider(t *testing.T) {
	s := NewService()
	_, err := s.StartSingle(context.Background(), InstanceSpec{Name: "x"}, "ghost")
	if err == nil {
		t.Fatal("expected error for unregistered provider")
	}
	var target *ErrProviderUnavailable
	if !errors.As(err, &target) {
		t.Errorf("expected *ErrProviderUnavailable, got %T: %v", err, err)
	}
	if target.Provider != "ghost" {
		t.Errorf("expected provider name 'ghost' in error, got %q", target.Provider)
	}
}

func TestService_StartSingle_PassesSpecThrough(t *testing.T) {
	s := NewService()
	p := &mockProvider{
		id:        "mock",
		startInfo: InstanceInfo{ProviderID: "mock", Host: "127.0.0.1", Port: 6000, Name: "pg"},
	}
	s.RegisterProvider(p)

	spec := InstanceSpec{Name: "pg", PGVersion: "18", Port: 6000}
	info, err := s.StartSingle(context.Background(), spec, "mock")
	if err != nil {
		t.Fatalf("StartSingle returned error: %v", err)
	}
	if info.ProviderID != "mock" || info.Port != 6000 {
		t.Errorf("got info %+v, want provider=mock port=6000", info)
	}
	if len(p.startCalls) != 1 {
		t.Fatalf("expected 1 Start call, got %d", len(p.startCalls))
	}
	if p.startCalls[0].Name != spec.Name ||
		p.startCalls[0].PGVersion != spec.PGVersion ||
		p.startCalls[0].Port != spec.Port {
		t.Errorf("provider received spec %+v, want name=%q pgVersion=%q port=%d",
			p.startCalls[0], spec.Name, spec.PGVersion, spec.Port)
	}
}

func TestService_StartSingle_PropagatesError(t *testing.T) {
	s := NewService()
	boom := errors.New("kaboom")
	s.RegisterProvider(&mockProvider{id: "mock", startErr: boom})

	_, err := s.StartSingle(context.Background(), InstanceSpec{Name: "x"}, "mock")
	if !errors.Is(err, boom) {
		t.Errorf("expected wrapped boom error, got %v", err)
	}
}

// ---------- Service: StopInstance ----------

func TestService_StopInstance_UnknownProvider(t *testing.T) {
	s := NewService()
	err := s.StopInstance(context.Background(), InstanceInfo{ProviderID: "ghost"})
	if err == nil {
		t.Fatal("expected error for unknown provider on StopInstance")
	}
	var target *ErrProviderUnavailable
	if !errors.As(err, &target) {
		t.Errorf("expected *ErrProviderUnavailable, got %T", err)
	}
}

func TestService_StopInstance_RoutesByProviderID(t *testing.T) {
	s := NewService()
	p := &mockProvider{id: "mock"}
	s.RegisterProvider(p)

	info := InstanceInfo{ProviderID: "mock", Name: "x"}
	if err := s.StopInstance(context.Background(), info); err != nil {
		t.Fatalf("StopInstance returned error: %v", err)
	}
	if len(p.stopCalls) != 1 || p.stopCalls[0] != info {
		t.Errorf("expected provider to receive stop call with %+v, got %+v", info, p.stopCalls)
	}
}

// ---------- error types ----------

func TestErrProviderUnavailable_Message(t *testing.T) {
	e := &ErrProviderUnavailable{Provider: "docker", Reason: "no socket"}
	got := e.Error()
	if !strings.Contains(got, "docker") || !strings.Contains(got, "no socket") {
		t.Errorf("expected message to contain provider+reason, got %q", got)
	}
}

func TestErrPortConflict_Message(t *testing.T) {
	e := &ErrPortConflict{Port: 5432}
	if !strings.Contains(e.Error(), "5432") {
		t.Errorf("expected message to mention port, got %q", e.Error())
	}
}

// ---------- sanitizeContainerName ----------

func TestSanitizeContainerName_AllowedChars(t *testing.T) {
	got := sanitizeContainerName("abcXYZ09_.-")
	if got != "abcXYZ09_.-" {
		t.Errorf("expected name to pass through unchanged, got %q", got)
	}
}

func TestSanitizeContainerName_ReplacesInvalid(t *testing.T) {
	got := sanitizeContainerName("a b/c")
	if got != "a_b_c" {
		t.Errorf("expected 'a_b_c', got %q", got)
	}
}

func TestSanitizeContainerName_LeadingNonAlphanumeric(t *testing.T) {
	// First char is invalid → must be prefixed to keep docker happy
	// (docker requires names to start with [a-zA-Z0-9]).
	got := sanitizeContainerName("!foo")
	if !isAlphaNumeric(got[0]) {
		t.Errorf("expected first char alphanumeric, got %q (full %q)", got[0], got)
	}
}

func TestSanitizeContainerName_Empty(t *testing.T) {
	got := sanitizeContainerName("")
	// Must still be a valid docker name (alphanumeric start, non-empty).
	if got == "" || !isAlphaNumeric(got[0]) {
		t.Errorf("expected a valid non-empty fallback name, got %q", got)
	}
}

// ---------- ComposeGenerator ----------

func TestComposeGenerator_Physical(t *testing.T) {
	g := NewComposeGenerator()
	out, err := g.GeneratePhysicalCompose()
	if err != nil {
		t.Fatalf("GeneratePhysicalCompose returned error: %v", err)
	}
	mustContainAll(t, out, []string{
		"version:", "services:", "primary:", "standby:",
		"wal_level=replica", "hot_standby=on",
		"pg_basebackup", "primary_data:", "standby_data:",
	})
}

func TestComposeGenerator_Logical(t *testing.T) {
	g := NewComposeGenerator()
	out, err := g.GenerateLogicalCompose()
	if err != nil {
		t.Fatalf("GenerateLogicalCompose returned error: %v", err)
	}
	mustContainAll(t, out, []string{
		"version:", "services:", "publisher:", "subscriber:",
		"wal_level=logical", "max_replication_slots=10",
		"publisher_data:", "subscriber_data:",
	})
}

func TestComposeGenerator_PhysicalDiffersFromLogical(t *testing.T) {
	g := NewComposeGenerator()
	phys, _ := g.GeneratePhysicalCompose()
	logic, _ := g.GenerateLogicalCompose()
	if phys == logic {
		t.Error("physical and logical compose output should differ")
	}
	// And the structural markers should be distinct.
	if !strings.Contains(phys, "primary:") || strings.Contains(phys, "publisher:") {
		t.Errorf("physical compose should mention 'primary' and not 'publisher'")
	}
	if !strings.Contains(logic, "publisher:") || strings.Contains(logic, "primary:") {
		t.Errorf("logical compose should mention 'publisher' and not 'primary'")
	}
}

// ---------- helpers ----------

func mustContainAll(t *testing.T, s string, parts []string) {
	t.Helper()
	for _, p := range parts {
		if !strings.Contains(s, p) {
			t.Errorf("output missing %q\n--- output ---\n%s", p, s)
		}
	}
}

func isAlphaNumeric(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9')
}

// Sanity: ensures we never accidentally fabricate a partial mock in
// a future test (helps `go vet` notice missing interface methods).
var _ ReplicationProvider = (*mockProvider)(nil)
var _ = fmt.Sprintf
