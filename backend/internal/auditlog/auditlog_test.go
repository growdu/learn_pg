package auditlog

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
)

// newTestLogger returns a Logger that writes JSON to a buffer and a
// handle to the buffer for assertions. The default channel buffer
// is large enough that the test can drain without dropping records.
func newTestLogger(t *testing.T) (*Logger, *bytes.Buffer) {
	t.Helper()
	buf := &bytes.Buffer{}
	h := slog.NewJSONHandler(buf, &slog.HandlerOptions{Level: slog.LevelInfo})
	l := NewWithLogger(slog.New(h))
	t.Cleanup(func() { _ = l.Close() })
	return l, buf
}

func TestLogWritesStructuredRecord(t *testing.T) {
	l, buf := newTestLogger(t)
	l.Log(
		context.Background(),
		ActionConnect, "127.0.0.1", "POST", "/api/connect", "success",
		map[string]any{"host": "10.0.0.1", "port": 5432, "user": "alice"},
	)
	if err := l.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	dec := json.NewDecoder(strings.NewReader(buf.String()))
	var rec map[string]any
	if err := dec.Decode(&rec); err != nil {
		t.Fatalf("decode: %v\nbuf=%s", err, buf.String())
	}
	if rec["action"] != ActionConnect {
		t.Errorf("action = %v, want %v", rec["action"], ActionConnect)
	}
	if rec["actor"] != "127.0.0.1" {
		t.Errorf("actor = %v, want 127.0.0.1", rec["actor"])
	}
	if rec["method"] != "POST" {
		t.Errorf("method = %v", rec["method"])
	}
	if rec["path"] != "/api/connect" {
		t.Errorf("path = %v", rec["path"])
	}
	if rec["outcome"] != "success" {
		t.Errorf("outcome = %v", rec["outcome"])
	}
	if rec["host"] != "10.0.0.1" {
		t.Errorf("host = %v", rec["host"])
	}
	if rec["subsystem"] != "audit" {
		t.Errorf("subsystem = %v", rec["subsystem"])
	}
}

func TestLogStripsSecrets(t *testing.T) {
	l, buf := newTestLogger(t)
	l.Log(
		context.Background(),
		ActionConnect, "127.0.0.1", "POST", "/api/connect", "success",
		map[string]any{
			"host":     "10.0.0.1",
			"password": "supersecret",
			"dsn":      "postgres://u:p@h/db",
			"token":    "abc",
		},
	)
	_ = l.Close()

	out := buf.String()
	if strings.Contains(out, "supersecret") {
		t.Errorf("password leaked into audit log: %s", out)
	}
	if strings.Contains(out, "abc") {
		t.Errorf("token leaked into audit log: %s", out)
	}
	// The raw DSN contains a password fragment; "u:p" should not
	// appear because dsn itself is on the secret list.
	if strings.Contains(out, "u:p@") {
		t.Errorf("DSN leaked into audit log: %s", out)
	}
	if !strings.Contains(out, "<redacted>") {
		t.Errorf("expected redaction marker in output: %s", out)
	}
	// Non-secret fields should still be present.
	if !strings.Contains(out, "10.0.0.1") {
		t.Errorf("host should still be present: %s", out)
	}
}

func TestLogStripsNestedSecrets(t *testing.T) {
	l, buf := newTestLogger(t)
	l.Log(
		context.Background(),
		ActionConnect, "x", "POST", "/p", "success",
		map[string]any{
			"dsn_parsed": map[string]any{
				"host":     "db",
				"password": "leakme",
			},
		},
	)
	_ = l.Close()
	out := buf.String()
	if strings.Contains(out, "leakme") {
		t.Errorf("nested password leaked: %s", out)
	}
}

func TestLogNonBlockingOnFullChannel(t *testing.T) {
	buf := &bytes.Buffer{}
	h := slog.NewJSONHandler(buf, &slog.HandlerOptions{Level: slog.LevelInfo})
	l := &Logger{
		sink:       make(chan record, 1),
		underlying: slog.New(h).With(subsystemKey, "audit"),
	}
	l.wg.Add(1)
	go l.run()

	// Fill the channel.
	l.Log(context.Background(), "a", "x", "GET", "/", "success", nil)
	// Now hammer it; channel is full so most should drop.
	for i := 0; i < 100; i++ {
		l.Log(context.Background(), "a", "x", "GET", "/", "success", nil)
	}
	dropped := l.Dropped()
	if dropped == 0 {
		t.Errorf("expected some drops, got 0")
	}
	// Drain.
	_ = l.Close()
}

func TestActorFromRequest(t *testing.T) {
	// nil request → "-".
	if got := ActorFromRequest(nil); got != "-" {
		t.Errorf("nil request: got %q, want %q", got, "-")
	}

	// httptest.NewRequest sets RemoteAddr to "192.0.2.1:1234".
	r := httptest.NewRequest("GET", "/", nil)
	if got := ActorFromRequest(r); got != "192.0.2.1" {
		t.Errorf("RemoteAddr: got %q, want %q", got, "192.0.2.1")
	}

	// X-Forwarded-For with multiple hops — take the first.
	r2 := httptest.NewRequest("GET", "/", nil)
	r2.Header.Set("X-Forwarded-For", "10.1.1.1, 10.1.1.2")
	if got := ActorFromRequest(r2); got != "10.1.1.1" {
		t.Errorf("X-Forwarded-For first-hop: got %q, want %q", got, "10.1.1.1")
	}
}

func TestSetDefaultAndPackageLevelLog(t *testing.T) {
	buf := &bytes.Buffer{}
	h := slog.NewJSONHandler(buf, &slog.HandlerOptions{Level: slog.LevelInfo})
	l := NewWithLogger(slog.New(h))
	SetDefault(l)
	defer SetDefault(nil)
	defer func() { _ = l.Close() }()

	Log(context.Background(), ActionExecute, "tester", "POST", "/api/execute", "success", map[string]any{"sql_truncated": "SELECT 1"})
	_ = l.Close()

	if !strings.Contains(buf.String(), "tester") {
		t.Errorf("package-level Log didn't reach the underlying sink: %s", buf.String())
	}
	if !strings.Contains(buf.String(), `"action":"pg.execute"`) {
		t.Errorf("action field missing or wrong: %s", buf.String())
	}
}

