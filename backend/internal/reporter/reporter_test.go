package reporter

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestNoOpWhenDSNEmpty(t *testing.T) {
	r := New(Config{})
	if r.Enabled() {
		t.Error("Enabled() should be false with empty DSN")
	}
	r.CaptureError(errors.New("ignored"))
	r.CaptureError(nil)
	// Flush/Shutdown on no-op should not panic or block.
	if err := r.Flush(10 * time.Millisecond); err != nil {
		t.Errorf("Flush on no-op: %v", err)
	}
	r.Shutdown()
	sent, dropped := r.Stats()
	if sent != 0 || dropped != 0 {
		t.Errorf("Stats = (%d,%d), want (0,0)", sent, dropped)
	}
}

func TestParseDSN(t *testing.T) {
	endpoint, auth, err := parseDSN("https://abc123@o456.ingest.sentry.io/789")
	if err != nil {
		t.Fatalf("parseDSN: %v", err)
	}
	want := "https://o456.ingest.sentry.io/789/envelope/"
	if endpoint != want {
		t.Errorf("endpoint = %q, want %q", endpoint, want)
	}
	wantAuth := "sentry_version=7, sentry_key=abc123"
	if auth != wantAuth {
		t.Errorf("auth = %q, want %q", auth, wantAuth)
	}
}

func TestParseDSNRejectsBad(t *testing.T) {
	cases := []string{
		"",
		"http://abc@example.com/1",  // wrong scheme
		"https://noatsign",
		"https://@nokey.com/1",
		"https://noproject@host/",
	}
	for _, dsn := range cases {
		if _, _, err := parseDSN(dsn); err == nil {
			t.Errorf("parseDSN(%q): expected error", dsn)
		}
	}
}

func TestCaptureErrorShips(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	// Build a DSN that points at our test server. We need to
	// re-shape the DSN because parseDSN expects the
	// sentry.io/<id> shape, but we want a generic host. Patch
	// by injecting a custom DSN that still parses.
	// Simpler: use a DSN that parses and then override the
	// endpoint afterwards. We test the round trip via a custom
	// DSN by replacing the parsed endpoint.
	dsn := "https://public@o1.ingest.sentry.io/1"
	r := New(Config{DSN: dsn, Release: "test-1"})
	// Swap the endpoint to point at the test server.
	r.endpoint = srv.URL + "/envelope/"

	r.CaptureError(errors.New("boom"))
	if err := r.Flush(2 * time.Second); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	r.Shutdown()
	if atomic.LoadInt32(&hits) == 0 {
		t.Errorf("test server got no requests; reporter not sending")
	}
}

func TestCaptureErrorServerErrorCountsAsDrop(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	dsn := "https://public@o1.ingest.sentry.io/1"
	r := New(Config{DSN: dsn})
	r.endpoint = srv.URL + "/envelope/"
	r.CaptureError(errors.New("boom"))
	r.Flush(time.Second)
	r.Shutdown()
	if _, dropped := r.Stats(); dropped == 0 {
		t.Errorf("expected dropped >= 1, got 0")
	}
}

func TestQueueFullDrops(t *testing.T) {
	// Slow server so the queue fills before the sender can drain.
	gate := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-gate
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	defer close(gate)
	dsn := "https://public@o1.ingest.sentry.io/1"
	r := New(Config{DSN: dsn})
	r.endpoint = srv.URL + "/envelope/"
	// Fire 1000 errors; the queue caps at 256 so the rest must drop.
	for i := 0; i < 1000; i++ {
		r.CaptureError(fmt.Errorf("err %d", i))
	}
	// No sleep: CaptureError is non-blocking and overflow drops immediately.
	_, dropped := r.Stats()
	if dropped == 0 {
		t.Errorf("expected drops, got 0")
	}
}

func TestCapturePanicRePanics(t *testing.T) {
	r := New(Config{})
	defer func() {
		if rec := recover(); rec == nil {
			t.Error("expected re-panic")
		}
	}()
	func() {
		defer CapturePanic(r, "test")
		panic("kaboom")
	}()
}

func TestCapturePanicWithReporter(t *testing.T) {
	// We don't have a real server; just confirm that a panicking
	// closure hooked up to a real reporter doesn't deadlock and
	// re-panics.
	dsn := "https://public@o1.ingest.sentry.io/1"
	r := New(Config{DSN: dsn})
	defer r.Shutdown()
	defer func() {
		if rec := recover(); rec == nil {
			t.Error("expected re-panic")
		}
	}()
	func() {
		defer CapturePanic(r, "test")
		panic("kaboom")
	}()
}

func TestFromContext(t *testing.T) {
	r := New(Config{DSN: "https://public@o1.ingest.sentry.io/1"})
	defer r.Shutdown()
	ctx := WithContext(context.Background(), r)
	if got := FromContext(ctx); got != r {
		t.Error("FromContext did not return stored reporter")
	}
	// Without context value, returns a no-op.
	if got := FromContext(context.Background()); got == nil {
		t.Error("FromContext should never return nil")
	} else if got.Enabled() {
		t.Error("FromContext with empty ctx should return no-op reporter")
	}
}

func TestSplitStack(t *testing.T) {
	in := "goroutine 1 [running]:\nfoo()\n\t/foo.go:42 +0x12\n"
	got := splitStack(in)
	if len(got) == 0 {
		t.Errorf("splitStack produced no frames")
	}
}
