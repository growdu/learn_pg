package ratelimit

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"
)

func newTestReq(method, path, remoteAddr string) *http.Request {
	r := httptest.NewRequest(method, path, nil)
	r.RemoteAddr = remoteAddr
	return r
}

func TestRouteBucket(t *testing.T) {
	cases := map[string]string{
		"/ws":              "ws",
		"/ws/foo":          "ws",
		"/api/auth/login":  "auth",
		"/api/auth/refresh": "auth",
		"/api/discovery":   "api",
		"/api/x/y":         "api",
		"/health":          "default",
		"/":                "default",
	}
	for in, want := range cases {
		if got := RouteBucket(in); got != want {
			t.Errorf("RouteBucket(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestLimiterAllowsBurstThenBlocks(t *testing.T) {
	lim := New(Options{
		Capacity:         3,
		RefillPerSecond:  0, // no refill; exhaust quickly
		KeyFunc:          func(r *http.Request) string { return "ip-1" },
		Exempt:           func(r *http.Request) bool { return false },
	})
	// Pin time so the bucket doesn't refuel via wall clock.
	lim.now = func() time.Time { return time.Unix(0, 0) }

	h := lim.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	// 3 hits inside the burst should pass.
	for i := 0; i < 3; i++ {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, newTestReq("GET", "/api/x", "1.2.3.4:80"))
		if rr.Code != http.StatusOK {
			t.Fatalf("hit %d: got %d, want 200", i, rr.Code)
		}
	}
	// 4th hit must be 429.
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, newTestReq("GET", "/api/x", "1.2.3.4:80"))
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("4th hit: got %d, want 429", rr.Code)
	}
	if got := rr.Header().Get("Retry-After"); got == "" {
		t.Errorf("Retry-After header missing on 429")
	}
	if got := rr.Header().Get("X-RateLimit-Limit"); got != "3" {
		t.Errorf("X-RateLimit-Limit = %q, want 3", got)
	}
}

func TestLimiterExemptBypasses(t *testing.T) {
	lim := New(Options{Capacity: 1, RefillPerSecond: 0})
	lim.now = func() time.Time { return time.Unix(0, 0) }
	calls := 0
	h := lim.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusOK)
	}))
	for _, path := range []string{"/ws", "/metrics", "/health", "/readyz", "/livez", "/version"} {
		for i := 0; i < 5; i++ {
			rr := httptest.NewRecorder()
			h.ServeHTTP(rr, newTestReq("GET", path, "1.1.1.1:80"))
			if rr.Code != http.StatusOK {
				t.Errorf("exempt path %s hit %d: got %d, want 200", path, i, rr.Code)
			}
		}
	}
	if calls != 30 {
		t.Errorf("expected 30 handler calls, got %d", calls)
	}
}

func TestLimiterSeparateKeys(t *testing.T) {
	lim := New(Options{Capacity: 1, RefillPerSecond: 0})
	lim.now = func() time.Time { return time.Unix(0, 0) }
	h := lim.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	// Two different IPs each get their own burst.
	for _, ip := range []string{"1.1.1.1:80", "2.2.2.2:80"} {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, newTestReq("GET", "/api/x", ip))
		if rr.Code != http.StatusOK {
			t.Errorf("first hit for %s: got %d, want 200", ip, rr.Code)
		}
	}
	// Both IPs now exhausted; 2nd hit on either must be 429.
	for _, ip := range []string{"1.1.1.1:80", "2.2.2.2:80"} {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, newTestReq("GET", "/api/x", ip))
		if rr.Code != http.StatusTooManyRequests {
			t.Errorf("second hit for %s: got %d, want 429", ip, rr.Code)
		}
	}
}

func TestLimiterRefillsOverTime(t *testing.T) {
	var fakeNow time.Time = time.Unix(0, 0)
	lim := New(Options{
		Capacity: 1, RefillPerSecond: 1,
		KeyFunc: func(r *http.Request) string { return "ip" },
		Exempt:  func(r *http.Request) bool { return false },
	})
	lim.now = func() time.Time { return fakeNow }
	h := lim.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	// Burn the single token.
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, newTestReq("GET", "/api/x", "ip:0"))
	if rr.Code != http.StatusOK {
		t.Fatalf("first: got %d, want 200", rr.Code)
	}
	// Immediately after: 429.
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, newTestReq("GET", "/api/x", "ip:0"))
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("immediate retry: got %d, want 429", rr.Code)
	}
	// Advance the fake clock by 2 seconds -> one token refilled.
	fakeNow = fakeNow.Add(2 * time.Second)
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, newTestReq("GET", "/api/x", "ip:0"))
	if rr.Code != http.StatusOK {
		t.Fatalf("after refill: got %d, want 200", rr.Code)
	}
}

func TestLimiterConcurrentSafe(t *testing.T) {
	lim := New(Options{Capacity: 100, RefillPerSecond: 0})
	h := lim.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rr := httptest.NewRecorder()
			h.ServeHTTP(rr, newTestReq("GET", "/api/x", "9.9.9.9:80"))
		}()
	}
	wg.Wait()
}

func TestDefaultKeyFunc(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "10.0.0.5:54321"
	if got := defaultKeyFunc(r); got != "10.0.0.5" {
		t.Errorf("defaultKeyFunc = %q", got)
	}
	// Bad RemoteAddr returns as-is.
	r.RemoteAddr = "no-port"
	if got := defaultKeyFunc(r); got != "no-port" {
		t.Errorf("defaultKeyFunc bad addr = %q", got)
	}
}

// silence unused-import vet warning if any test above is removed.
var _ = strconv.Itoa
