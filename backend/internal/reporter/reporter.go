// Package reporter provides a thin, no-dep abstraction over error
// reporting so the rest of the backend can call
// reporter.FromContext(ctx).CaptureError(err) without caring whether
// the project has Sentry wired up or not.
//
// When REPORT_DSN is empty (the default), all methods are no-ops and
// the program runs with zero external dependencies. When set to a
// Sentry DSN, the implementation buffers events to a bounded channel
// and ships them off in a background goroutine — the request hot
// path never blocks on the network.
package reporter

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"
)

// Config configures the reporter. Zero values mean "no reporter".
type Config struct {
	// DSN is the Sentry-style DSN. Empty disables the reporter.
	DSN string
	// Environment, e.g. "production", "staging", "dev".
	Environment string
	// Release is the build version. Set from -ldflags at build time.
	Release string
	// SampleRate is the fraction of error events to send (0..1).
	// 0 or 1 both mean "send everything"; intermediate values let
	// you dial down volume in production. Default 1.0.
	SampleRate float64
	// FlushTimeout is the maximum time the Shutdown call will wait
	// for the queue to drain. Default 5s.
	FlushTimeout time.Duration
}

// Reporter forwards error events to a Sentry-compatible endpoint.
// All methods are safe for concurrent use.
type Reporter struct {
	cfg     Config
	queue   chan event
	stop    chan struct{}
	done    chan struct{}
	dropped uint64
	sent    uint64

	// Sentry-compatible envelope endpoint parsed from DSN.
	endpoint string
	auth     string
	client   *http.Client
	once     sync.Once
}

// event is a single Sentry-shaped error payload. We use the
// "envelope" format's "event" item verbatim so we don't need a Sentry
// SDK.
type event struct {
	Timestamp  time.Time              `json:"timestamp"`
	Platform   string                 `json:"platform"`
	Logger     string                 `json:"logger,omitempty"`
	Level      string                 `json:"level"`
	Environment string                `json:"environment,omitempty"`
	Release    string                 `json:"release,omitempty"`
	Message    map[string]interface{} `json:"message,omitempty"`
	Exception  map[string]interface{} `json:"exception,omitempty"`
}

// New returns a Reporter. If cfg.DSN is empty, the returned Reporter
// is a no-op (CaptureError, CapturePanic, Flush, Shutdown are all
// cheap and side-effect-free).
func New(cfg Config) *Reporter {
	r := &Reporter{cfg: cfg}
	if cfg.SampleRate == 0 {
		r.cfg.SampleRate = 1.0
	}
	if cfg.FlushTimeout == 0 {
		r.cfg.FlushTimeout = 5 * time.Second
	}
	if cfg.DSN == "" {
		// No-op reporter. We still return a non-nil value so callers
		// don't have to nil-check; CaptureError etc. will short-circuit.
		return r
	}
	endpoint, auth, err := parseDSN(cfg.DSN)
	if err != nil {
		slog.Warn("reporter: invalid DSN, disabling", "error", err)
		return r
	}
	r.endpoint = endpoint
	r.auth = auth
	r.queue = make(chan event, 256)
	r.stop = make(chan struct{})
	r.done = make(chan struct{})
	r.client = &http.Client{Timeout: 5 * time.Second}
	go r.run()
	return r
}

// Enabled reports whether the reporter is actively shipping events.
// Useful for tests and for an opt-in /version response field.
func (r *Reporter) Enabled() bool { return r.endpoint != "" }

// Stats returns counts of events sent and dropped. Cheap; safe to
// read in a request hot path.
func (r *Reporter) Stats() (sent, dropped uint64) {
	return atomic.LoadUint64(&r.sent), atomic.LoadUint64(&r.dropped)
}

// CaptureError sends an error to the reporter. A nil error is a
// no-op. Errors are sampled according to SampleRate.
func (r *Reporter) CaptureError(err error) {
	if err == nil || !r.Enabled() {
		return
	}
	// Cheap rejection sampling using a per-call hash so we don't
	// coordinate state for the common case (rate=1).
	if r.cfg.SampleRate < 1.0 {
		// Use a time-derived fraction. Atomicity isn't required;
		// sampling is best-effort.
		n := uint64(time.Now().UnixNano())
		if float64(n%10000)/10000.0 > r.cfg.SampleRate {
			atomic.AddUint64(&r.dropped, 1)
			return
		}
	}
	r.enqueue(eventFromError(err))
}

// CapturePanic recovers from a panic, reports it, and re-panics.
// Intended to be used as `defer reporter.CapturePanic(r, "handler")`
// in critical paths. If `r` is nil, the panic is still recovered and
// logged, but never reported.
func CapturePanic(r *Reporter, context string) {
	rec := recover()
	if rec == nil {
		return
	}
	if r != nil {
		r.enqueue(eventFromPanic(rec, context))
	}
	slog.Error("panic recovered",
		"context", context,
		"recovered", fmt.Sprintf("%v", rec),
		"stack", string(debug.Stack()),
	)
	if r != nil {
		// Best-effort flush so the panic event actually leaves
		// the process. Bounded so a stuck network can't block exit.
		_ = r.Flush(2 * time.Second)
	}
	panic(rec)
}

// Flush blocks until the queue is empty or timeout elapses.
func (r *Reporter) Flush(timeout time.Duration) error {
	if !r.Enabled() {
		return nil
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if len(r.queue) == 0 {
			return nil
		}
		time.Sleep(20 * time.Millisecond)
	}
	return fmt.Errorf("reporter: flush timed out with %d events buffered", len(r.queue))
}

// Shutdown stops the background sender and flushes the queue. Safe
// to call multiple times.
func (r *Reporter) Shutdown() {
	if !r.Enabled() {
		return
	}
	r.once.Do(func() {
		close(r.stop)
		<-r.done
	})
}

func (r *Reporter) enqueue(e event) {
	if !r.Enabled() {
		return
	}
	select {
	case r.queue <- e:
	default:
		// Queue full — drop and count.
		atomic.AddUint64(&r.dropped, 1)
	}
}

func (r *Reporter) run() {
	defer close(r.done)
	for {
		select {
		case <-r.stop:
			// Drain remaining events on shutdown.
			for {
				select {
				case e := <-r.queue:
					r.send(e)
				default:
					return
				}
			}
		case e := <-r.queue:
			r.send(e)
		}
	}
}

func (r *Reporter) send(e event) {
	body, err := json.Marshal(e)
	if err != nil {
		atomic.AddUint64(&r.dropped, 1)
		return
	}
	// Sentry envelope format: header line + payload line.
	envelope, _ := json.Marshal(struct {
		EventID string `json:"event_id"`
	}{EventID: randomEventID()})
	envelope = append(envelope, '\n')
	envelope = append(envelope, body...)
	envelope = append(envelope, '\n')

	req, err := http.NewRequest(http.MethodPost, r.endpoint, bytes.NewReader(envelope))
	if err != nil {
		atomic.AddUint64(&r.dropped, 1)
		return
	}
	req.Header.Set("Content-Type", "application/x-sentry-envelope")
	req.Header.Set("X-Sentry-Auth", r.auth)
	resp, err := r.client.Do(req)
	if err != nil {
		atomic.AddUint64(&r.dropped, 1)
		return
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		atomic.AddUint64(&r.sent, 1)
	} else {
		atomic.AddUint64(&r.dropped, 1)
	}
}

func eventFromError(err error) event {
	return event{
		Timestamp:   time.Now().UTC(),
		Platform:    "go",
		Level:       "error",
		Environment: envVal(),
		Release:     releaseVal(),
		Message: map[string]interface{}{
			"formatted": err.Error(),
		},
	}
}

func eventFromPanic(rec interface{}, context string) event {
	return event{
		Timestamp:   time.Now().UTC(),
		Platform:    "go",
		Level:       "fatal",
		Environment: envVal(),
		Release:     releaseVal(),
		Exception: map[string]interface{}{
			"values": []map[string]interface{}{{
				"type":    "panic",
				"value":   fmt.Sprintf("%v", rec),
				"stacktrace": map[string]interface{}{
					"frames": splitStack(string(debug.Stack())),
				},
			}},
		},
		Message: map[string]interface{}{
			"formatted": "panic in " + context,
		},
	}
}

// splitStack turns a runtime/debug.Stack() blob into a list of
// "module:function (file:line)" strings. We only keep lines that
// reference a .go file with a hex offset - those are the file:line
// half of a stack frame, which uniquely identifies the location
// without depending on which Go version added or removed the
// function-name lines.
func splitStack(s string) []string {
	out := []string{}
	for _, line := range bytes.Split([]byte(s), []byte("\n")) {
		if !bytes.Contains(line, []byte(".go:")) || !bytes.Contains(line, []byte("+0x")) {
			continue
		}
		out = append(out, string(line))
	}
	return out
}

var (
	cachedEnv     string
	cachedEnvOnce sync.Once
)

func envVal() string {
	cachedEnvOnce.Do(func() { cachedEnv = os.Getenv("APP_ENV") })
	return cachedEnv
}

var (
	cachedRelease     string
	cachedReleaseOnce sync.Once
)

func releaseVal() string {
	cachedReleaseOnce.Do(func() { cachedRelease = os.Getenv("APP_RELEASE") })
	return cachedRelease
}

func randomEventID() string {
	// 32 hex chars (16 bytes) — UUIDv4-shaped.
	var b [16]byte
	for i := range b {
		b[i] = byte(time.Now().UnixNano() >> (uint(i) % 8 * 8))
	}
	const hex = "0123456789abcdef"
	out := make([]byte, 32)
	for i, x := range b {
		out[i*2] = hex[x>>4]
		out[i*2+1] = hex[x&0x0f]
	}
	return string(out)
}

// parseDSN extracts the envelope endpoint and X-Sentry-Auth value
// from a Sentry DSN of the form
//   https://<publicKey>@o<orgId>.ingest.sentry.io/<projectId>
// We don't import the Sentry SDK to keep the dependency surface
// minimal; the format is stable and small enough to parse by hand.
func parseDSN(dsn string) (endpoint, auth string, err error) {
	// Example: https://abc123@o123.ingest.sentry.io/456
	const prefix = "https://"
	if len(dsn) < len(prefix) || dsn[:len(prefix)] != prefix {
		return "", "", fmt.Errorf("reporter: DSN must start with %q", prefix)
	}
	rest := dsn[len(prefix):]
	at := bytes.IndexByte([]byte(rest), '@')
	if at < 0 {
		return "", "", fmt.Errorf("reporter: DSN missing '@' separator")
	}
	publicKey := rest[:at]
	hostPath := rest[at+1:]
	if len(publicKey) == 0 {
		return "", "", fmt.Errorf("reporter: DSN missing public key")
	}
	slash := bytes.LastIndexByte([]byte(hostPath), '/')
	if slash < 0 || len(hostPath)-slash-1 == 0 {
		return "", "", fmt.Errorf("reporter: DSN missing project id")
	}
	return "https://" + hostPath + "/envelope/",
		fmt.Sprintf("sentry_version=7, sentry_key=%s", publicKey),
		nil
}

// FromContext is a convenience for callers that stash the reporter
// on a context. Returns a no-op reporter if ctx has none.
func FromContext(ctx context.Context) *Reporter {
	if v, ok := ctx.Value(reporterKey{}).(*Reporter); ok {
		return v
	}
	return New(Config{})
}

type reporterKey struct{}

// WithContext returns ctx carrying r.
func WithContext(ctx context.Context, r *Reporter) context.Context {
	return context.WithValue(ctx, reporterKey{}, r)
}
