// Package ratelimit implements a small in-memory per-key token-bucket
// rate limiter, exposed as a Go middleware.
//
// Design notes
//
//   - One bucket per (key, route-bucket) pair. Route buckets are coarse
//     ("api", "ws", "auth") so we don't blow up memory on a noisy
//     attack surface that targets unique URLs. The exact key is
//     produced by keyFunc(r) — usually the client IP.
//   - Buckets are not GC'd; we accept a bounded leak (~O(routes *
//     distinct IPs) entries) since neither dimension is expected to
//     grow unbounded in this dev-leaning codebase. If that assumption
//     ever changes, swap in a map + LRU or move to Redis.
//   - Limiter is a struct, not a package-level singleton, so tests
//     and request contexts don't share state.
//   - WebSocket upgrade requests are exempt by default: throttling a
//     long-lived stream would just produce a confusing disconnect.
//   - On miss, the middleware responds with 429 + Retry-After.
package ratelimit

import (
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// bucketKey identifies a single token bucket.
type bucketKey struct {
	key   string
	route string
}

// bucket is a token bucket: capacity tokens, refill rate per second,
// last update timestamp.
type bucket struct {
	mu         sync.Mutex
	tokens     float64
	capacity   float64
	refillRate float64 // tokens per second
	last       time.Time
}

// take returns true if a token was successfully consumed and the
// suggested Retry-After duration when the bucket is empty.
func (b *bucket) take(now time.Time) (ok bool, retryAfter time.Duration) {
	b.mu.Lock()
	defer b.mu.Unlock()
	elapsed := now.Sub(b.last).Seconds()
	b.tokens += elapsed * b.refillRate
	if b.tokens > b.capacity {
		b.tokens = b.capacity
	}
	b.last = now
	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	deficit := 1 - b.tokens
	if b.refillRate <= 0 {
		return false, time.Second
	}
	return false, time.Duration(deficit/b.refillRate*float64(time.Second))
}

// RouteBucket classifies a request path into a coarse rate-limit
// bucket. Centralising the rules keeps the limiter from being
// coupled to every route's URL structure.
func RouteBucket(path string) string {
	switch {
	case path == "/ws" || strings.HasPrefix(path, "/ws/"):
		return "ws"
	case strings.HasPrefix(path, "/api/auth"):
		return "auth"
	case strings.HasPrefix(path, "/api/"):
		return "api"
	default:
		return "default"
	}
}

// Options configures a Limiter.
type Options struct {
	// Capacity is the burst size. Default 60.
	Capacity float64
	// RefillPerSecond is the steady-state rate. Default 20.
	RefillPerSecond float64
	// KeyFunc extracts the rate-limit key from a request (typically
	// the client IP). Defaults to ClientIP using r.RemoteAddr.
	KeyFunc func(*http.Request) string
	// Exempt returns true if this request should bypass the limiter
	// entirely. Defaults to exempting the /ws WebSocket endpoint.
	Exempt func(*http.Request) bool
}

// Limiter is an http.Handler middleware that throttles requests
// using per-key token buckets.
type Limiter struct {
	capacity   float64
	refillRate float64
	keyFunc    func(*http.Request) string
	exempt     func(*http.Request) bool

	mu      sync.Mutex
	buckets map[bucketKey]*bucket
	now     func() time.Time
}

// New returns a Limiter with the given options. Zero-value numeric
// fields fall back to sensible defaults.
func New(opts Options) *Limiter {
	if opts.Capacity <= 0 {
		opts.Capacity = 60
	}
	if opts.RefillPerSecond <= 0 {
		opts.RefillPerSecond = 20
	}
	if opts.KeyFunc == nil {
		opts.KeyFunc = defaultKeyFunc
	}
	if opts.Exempt == nil {
		opts.Exempt = defaultExempt
	}
	return &Limiter{
		capacity:   opts.Capacity,
		refillRate: opts.RefillPerSecond,
		keyFunc:    opts.KeyFunc,
		exempt:     opts.Exempt,
		buckets:    make(map[bucketKey]*bucket),
		now:        time.Now,
	}
}

func defaultKeyFunc(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func defaultExempt(r *http.Request) bool {
	return r.URL.Path == "/ws" || r.URL.Path == "/metrics" ||
		r.URL.Path == "/health" || r.URL.Path == "/readyz" ||
		r.URL.Path == "/livez" || r.URL.Path == "/version"
}

// Middleware returns the http.Handler middleware. The rate-limit
// decision is recorded in the response headers so a curious client
// can self-throttle.
func (l *Limiter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if l.exempt(r) {
			next.ServeHTTP(w, r)
			return
		}
		key := l.keyFunc(r)
		route := RouteBucket(r.URL.Path)
		now := l.now()
		b := l.getOrCreate(bucketKey{key: key, route: route})

		ok, retry := b.take(now)
		w.Header().Set("X-RateLimit-Limit", strconv.FormatFloat(l.capacity, 'f', -1, 64))
		if !ok {
			secs := int(retry.Seconds())
			if secs < 1 {
				secs = 1
			}
			w.Header().Set("Retry-After", strconv.Itoa(secs))
			http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (l *Limiter) getOrCreate(k bucketKey) *bucket {
	l.mu.Lock()
	defer l.mu.Unlock()
	if b, ok := l.buckets[k]; ok {
		return b
	}
	b := &bucket{
		tokens:     l.capacity,
		capacity:   l.capacity,
		refillRate: l.refillRate,
		last:       l.now(),
	}
	l.buckets[k] = b
	return b
}
