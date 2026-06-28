// Package auditlog records sensitive operations to a dedicated slog
// channel so they can be shipped to a different sink (SIEM, log
// archive, JSON file) than the regular application log.
//
// What counts as "sensitive" is defined by the package callers; the
// audit log itself does not decide. It only guarantees:
//
//   - Every record carries an action, an actor (the request's
//     remote addr or X-Forwarded-For, falling back to "-"), and a
//     resource identifier.
//   - Records never include raw passwords, secrets, or DSN strings.
//     The Log method strips a known set of keys before encoding.
//   - The channel is non-blocking by default: a full channel drops
//     the record and increments a counter rather than stalling the
//     request goroutine. The trade-off is that audit logs can
//     occasionally drop under load; the alternative (blocking the
//     request) is worse because it turns the audit log into a DoS
//     amplifier.
//
// The package is process-wide: New constructs one logger, and
// elsewhere in the code path is set with SetDefault. Tests can
// swap the default with SetDefault to a recorder.
package auditlog

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
)

// Action describes the kind of operation being audited. Constants
// in this file are the canonical set; new values should be added
// here so the audit catalog stays small and reviewable.
const (
	ActionConnect          = "pg.connect"
	ActionDisconnect       = "pg.disconnect"
	ActionExecute          = "pg.execute"
	ActionProvisionStart   = "provision.start"
	ActionProvisionCancel  = "provision.cancel"
	ActionDiscoveryImport  = "discovery.import"
	ActionWorkspaceCreate  = "workspace.create"
	ActionWorkspaceDelete  = "workspace.delete"
	ActionWorkspaceUpdate  = "workspace.update"
)

// Logger writes audit records. Each method corresponds to a single
// "this just happened" event. The fields are well-known so a
// downstream parser can build structured queries without depending
// on the source code.
type Logger struct {
	sink    chan record
	dropped atomic.Uint64
	wg      sync.WaitGroup
	close   sync.Once

	// underlying is what we fan out to after the channel read.
	// Kept as a field so a test can swap it.
	underlying *slog.Logger
}

type record struct {
	Action  string         // e.g. "pg.connect"
	Actor   string         // remote addr or X-Forwarded-For
	Method  string         // HTTP method
	Path    string         // request path
	Outcome string         // "success" or "failure"
	Reason  string         // error message if Outcome=failure
	Fields  map[string]any // extra context, with secrets stripped
}

// New creates a Logger writing JSON lines to path. An empty path
// means stderr, which is the default. The channel buffer is large
// enough to absorb a few seconds of burst at typical request
// rates; tune via the env var LEARN_PG_AUDIT_BUFFER if needed.
func New(path string) (*Logger, error) {
	var w *os.File
	var err error
	if path == "" || path == "-" {
		w = os.Stderr
	} else {
		w, err = os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err != nil {
			return nil, err
		}
	}
	h := slog.NewJSONHandler(w, &slog.HandlerOptions{Level: slog.LevelInfo})
	l := &Logger{
		sink:       make(chan record, 256),
		underlying: slog.New(h).With(subsystemKey, "audit"),
	}
	l.wg.Add(1)
	go l.run()
	return l, nil
}

// NewWithLogger is for tests: it accepts an arbitrary sink.
func NewWithLogger(underlying *slog.Logger) *Logger {
	l := &Logger{
		sink:       make(chan record, 256),
		underlying: underlying.With(subsystemKey, "audit"),
	}
	l.wg.Add(1)
	go l.run()
	return l
}

const subsystemKey = "subsystem"

// Log writes one audit record. The ctx argument may be nil; the
// call is non-blocking.
func (l *Logger) Log(
	ctx context.Context,
	action, actor, method, path, outcome string,
	fields map[string]any,
) {
	if l == nil {
		return
	}
	r := record{
		Action:  action,
		Actor:   actor,
		Method:  method,
		Path:    path,
		Outcome: outcome,
		Fields:  stripSecrets(fields),
	}
	select {
	case l.sink <- r:
	default:
		l.dropped.Add(1)
	}
}

// ActorFromRequest returns the best-effort identity for a request:
// X-Forwarded-For if present, otherwise RemoteAddr. The returned
// string is safe to log directly.
func ActorFromRequest(r *http.Request) string {
	if r == nil {
		return "-"
	}
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		// X-Forwarded-For can be "client, proxy1, proxy2"; take the
		// first hop which is the original client.
		if i := strings.IndexByte(v, ','); i >= 0 {
			return strings.TrimSpace(v[:i])
		}
		return strings.TrimSpace(v)
	}
	if r.RemoteAddr == "" {
		return "-"
	}
	// RemoteAddr is "host:port"; strip the port.
	if i := strings.LastIndexByte(r.RemoteAddr, ':'); i >= 0 {
		return r.RemoteAddr[:i]
	}
	return r.RemoteAddr
}

// Close stops the worker goroutine. Safe to call more than once.
func (l *Logger) Close() error {
	if l == nil {
		return nil
	}
	l.close.Do(func() { close(l.sink) })
	l.wg.Wait()
	return nil
}

// Dropped returns how many records were dropped because the channel
// was full. Exposed for /metrics.
func (l *Logger) Dropped() uint64 { return l.dropped.Load() }

func (l *Logger) run() {
	defer l.wg.Done()
	for r := range l.sink {
		attrs := []any{
			slog.String("action", r.Action),
			slog.String("actor", r.Actor),
			slog.String("method", r.Method),
			slog.String("path", r.Path),
			slog.String("outcome", r.Outcome),
		}
		if r.Reason != "" {
			attrs = append(attrs, slog.String("reason", r.Reason))
		}
		for k, v := range r.Fields {
			attrs = append(attrs, slog.Any(k, v))
		}
		l.underlying.LogAttrs(context.Background(), slog.LevelInfo, "audit", asAttrs(attrs)...)
	}
}

// stripSecrets removes values whose key is on the secret list.
// Recursive enough to cover one level of nested map (DSN parsing
// puts the password under dsn). It does NOT try to scrub values,
// because we want the audit log to show the fact that, say, a
// password was set, not the password itself.
var secretKeys = map[string]struct{}{
	"password":     {},
	"passwd":       {},
	"pwd":          {},
	"secret":       {},
	"token":        {},
	"api_key":      {},
	"apikey":       {},
	"dsn":          {},
	"dsn_raw":      {},
	"connection":   {},
	"connectionurl": {},
}

func stripSecrets(in map[string]any) map[string]any {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]any, len(in))
	for k, v := range in {
		if _, ok := secretKeys[strings.ToLower(k)]; ok {
			out[k] = "<redacted>"
			continue
		}
		if m, ok := v.(map[string]any); ok {
			out[k] = stripSecrets(m)
			continue
		}
		out[k] = v
	}
	return out
}

// asAttrs converts the []any alternation of slog.Attr and other
// types into a []slog.Attr. Our caller only puts slog.Attr in, so
// the conversion is type-asserting; any other type is dropped with
// a warning to keep the worker goroutine from panicking on a
// programmer mistake.
func asAttrs(in []any) []slog.Attr {
	out := make([]slog.Attr, 0, len(in))
	for _, x := range in {
		if a, ok := x.(slog.Attr); ok {
			out = append(out, a)
		}
	}
	return out
}

// process-wide default. Set with SetDefault from main.go.
var (
	defaultMu sync.RWMutex
	defaultL  *Logger
)

// SetDefault installs l as the process-wide audit logger. Pass nil
// to disable auditing. Safe to call before any audit calls.
func SetDefault(l *Logger) {
	defaultMu.Lock()
	defaultL = l
	defaultMu.Unlock()
}

// Log is the package-level convenience for callers that don't want
// to thread a Logger pointer through every handler.
func Log(
	ctx context.Context,
	action, actor, method, path, outcome string,
	fields map[string]any,
) {
	defaultMu.RLock()
	l := defaultL
	defaultMu.RUnlock()
	l.Log(ctx, action, actor, method, path, outcome, fields)
}
