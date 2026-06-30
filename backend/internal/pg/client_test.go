package pg

import (
	"strings"
	"testing"
)

// ---------- shouldUseQuery (unexported) ----------

func TestShouldUseQuerySelect(t *testing.T) {
	// shouldUseQuery is a pure prefix match — the caller is responsible
	// for lowercasing and trimming before invocation. We exercise the
	// exact contract the function enforces.
	cases := []struct {
		name string
		sql  string
		want bool
	}{
		{"select lowercase", "select 1", true},
		{"show", "show data_directory", true},
		{"with cte", "with x as (select 1) select * from x", true},
		{"values", "values (1,2,3)", true},
		{"explain", "explain select 1", true},
		{"describe", "describe users", true},
		{"desc", "desc users", true},
		{"insert ... returning", "insert into t values (1) returning id", true},
		{"update ... returning", "update t set x=1 returning id", true},
		{"delete ... returning", "delete from t where id=1 returning id", true},
		{"plain insert", "insert into t values (1)", false},
		{"plain update", "update t set x=1", false},
		{"plain delete", "delete from t", false},
		{"create table", "create table t (id int)", false},
		{"empty string", "", false},
		// Uppercase falls through: shouldUseQuery does NOT normalize —
		// the caller (Execute) does the ToLower+TrimSpace first. This
		// test pins the raw-function contract.
		{"uppercase select (un-normalized)", "SELECT id FROM users", false},
		{"leading whitespace (un-normalized)", "  select 1", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := shouldUseQuery(tc.sql); got != tc.want {
				t.Errorf("shouldUseQuery(%q) = %v, want %v", tc.sql, got, tc.want)
			}
		})
	}
}

// ---------- unconnected-state behavior ----------

func TestCloseOnUnconnectedClient(t *testing.T) {
	c := NewClient()
	// Should be safe to call on a never-connected client.
	if err := c.Close(); err != nil {
		t.Errorf("Close on unconnected client returned error: %v", err)
	}
}

func TestPingOnUnconnectedClient(t *testing.T) {
	c := NewClient()
	err := c.Ping()
	if err == nil {
		t.Fatal("expected Ping to error on unconnected client")
	}
	if !strings.Contains(err.Error(), "not connected") {
		t.Errorf("expected 'not connected' error, got %v", err)
	}
}

func TestExecuteOnUnconnectedClient(t *testing.T) {
	c := NewClient()
	if _, err := c.Execute("select 1"); err == nil {
		t.Fatal("expected Execute to error on unconnected client")
	}
}

func TestGetVersionOnUnconnectedClient(t *testing.T) {
	c := NewClient()
	if _, err := c.GetVersion(); err == nil {
		t.Fatal("expected GetVersion to error on unconnected client")
	}
}

func TestGetCurrentXidOnUnconnectedClient(t *testing.T) {
	c := NewClient()
	if _, err := c.GetCurrentXid(); err == nil {
		t.Fatal("expected GetCurrentXid to error on unconnected client")
	}
}

// ---------- ExecuteResult.String() ----------

func TestExecuteResultStringEmpty(t *testing.T) {
	r := &ExecuteResult{}
	if got := r.String(); got != "\n" {
		t.Errorf("expected just a header newline, got %q", got)
	}
}

func TestExecuteResultStringSingleRow(t *testing.T) {
	r := &ExecuteResult{
		Columns: []Column{{Name: "id"}, {Name: "name"}},
		Rows: []map[string]string{
			{"id": "1", "name": "alice"},
		},
		CommandTag: "1 row(s)",
	}
	got := r.String()
	for _, want := range []string{"id", "name", "alice", "1 row(s)"} {
		if !strings.Contains(got, want) {
			t.Errorf("String() output missing %q:\n%s", want, got)
		}
	}
}

func TestExecuteResultStringMultiRow(t *testing.T) {
	r := &ExecuteResult{
		Columns:    []Column{{Name: "n"}},
		Rows:       []map[string]string{{"n": "1"}, {"n": "2"}, {"n": "3"}},
		CommandTag: "3 row(s)",
	}
	got := r.String()
	if strings.Count(got, "1\t") < 1 {
		t.Errorf("expected row 1 in output:\n%s", got)
	}
	if strings.Count(got, "3\t") < 1 {
		t.Errorf("expected row 3 in output:\n%s", got)
	}
}

func TestExecuteResultStringOmitsCommandTagWhenEmpty(t *testing.T) {
	r := &ExecuteResult{
		Columns: []Column{{Name: "x"}},
		Rows:    []map[string]string{{"x": "y"}},
	}
	if strings.Contains(r.String(), "(") {
		t.Errorf("expected no parens when CommandTag is empty, got %q", r.String())
	}
}
