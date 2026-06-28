// Package metrics exposes Prometheus metrics for the backend.
//
// Two metric families are provided:
//
//   - HTTP metrics (counter + histogram), populated by WithHTTPMetrics
//     middleware that wraps the existing logger/recovery chain.
//   - Service metrics (gauges for active connections, project count,
//     provision task counts). These are scraped on demand via the
//     MetricsCollector callback so we don't have to wire hooks through
//     every package.
//
// The /metrics handler is registered by the server bootstrap. The /version
// handler reads from package-level vars populated via -ldflags at build
// time; missing values fall back to "dev".
package metrics

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// BuildInfo is set at build time via -ldflags "-X ...BuildInfo". The struct
// is intentionally tiny so ldflags don't drift.
var BuildInfo = struct {
	Version   string
	Commit    string
	BuildDate string
	GoVersion string
}{
	Version:   "dev",
	Commit:    "unknown",
	BuildDate: "unknown",
	GoVersion: "dev",
}

// SnapshotFunc is a lazy callback the registry uses to populate service
// gauges on every scrape. Returning zeros is fine.
type SnapshotFunc func() Snapshot

type Snapshot struct {
	ActiveWSClients   int
	ActivePGConns     int
	WorkspaceProjects int
	ProvisionTasks    int
}

var (
	httpRequests = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: "pgv",
			Subsystem: "http",
			Name:      "requests_total",
			Help:      "Total HTTP requests by route, method, and status.",
		},
		[]string{"route", "method", "status"},
	)
	httpDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Namespace: "pgv",
			Subsystem: "http",
			Name:      "request_duration_seconds",
			Help:      "HTTP request duration in seconds.",
			// Buckets cover the spectrum from sub-ms (proxy) to multi-second
			// (provision start). Wider on the high end since slow requests
			// are exactly what we want to spot.
			Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10},
		},
		[]string{"route", "method"},
	)

	svcWSClients = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Namespace: "pgv",
			Subsystem: "service",
			Name:      "ws_clients",
			Help:      "Currently connected WebSocket clients.",
		},
	)
	svcPGConns = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Namespace: "pgv",
			Subsystem: "service",
			Name:      "pg_connections",
			Help:      "Currently active PostgreSQL connections managed by the backend.",
		},
	)
	svcWorkspaceProjects = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Namespace: "pgv",
			Subsystem: "service",
			Name:      "workspace_projects",
			Help:      "Total workspace projects currently configured.",
		},
	)
	svcProvisionTasks = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Namespace: "pgv",
			Subsystem: "service",
			Name:      "provision_tasks",
			Help:      "Total provision tasks (running + completed) tracked on disk.",
		},
	)
)

// SnapshotProvider is set once at startup. If nil, the scrape still works
// but service gauges keep their last value.
var SnapshotProvider func() Snapshot

// collector runs the snapshot function on every scrape and updates the
// gauges. Implemented as a custom collector so we don't have to expose
// a scrape callback hook in every package.
type collector struct {
	desc *prometheus.Desc
}

func newServiceCollector() *collector {
	return &collector{
		desc: prometheus.NewDesc(
			"pgv_service_scrape_info",
			"Last scrape of service-level gauges.",
			nil, nil,
		),
	}
}

func (c *collector) Describe(ch chan<- *prometheus.Desc) {
	ch <- c.desc
}

func (c *collector) Collect(ch chan<- prometheus.Metric) {
	if SnapshotProvider != nil {
		snap := SnapshotProvider()
		svcWSClients.Set(float64(snap.ActiveWSClients))
		svcPGConns.Set(float64(snap.ActivePGConns))
		svcWorkspaceProjects.Set(float64(snap.WorkspaceProjects))
		svcProvisionTasks.Set(float64(snap.ProvisionTasks))
	}
	ch <- prometheus.MustNewConstMetric(c.desc, prometheus.GaugeValue, 1)
}

// Registry holds our metrics. We don't use prometheus.DefaultRegisterer
// because tests instantiate handlers multiple times and would collide on
// duplicate registration.
var Registry = prometheus.NewRegistry()

func init() {
	Registry.MustRegister(
		httpRequests, httpDuration,
		svcWSClients, svcPGConns, svcWorkspaceProjects, svcProvisionTasks,
		newServiceCollector(),
		// Go runtime + process metrics. Cheap and invaluable when
		// investigating goroutine leaks or GC pressure.
		prometheus.NewGoCollector(),
		prometheus.NewProcessCollector(prometheus.ProcessCollectorOpts{}),
	)
}

// Handler returns an HTTP handler that serves /metrics.
func Handler() http.Handler {
	return promhttp.HandlerFor(Registry, promhttp.HandlerOpts{
		EnableOpenMetrics: false, // stick to the classic text format
		Registry:          Registry,
	})
}

// HTTPMiddleware records per-request metrics. Wrap the existing chain
// (Logger → Recovery) — keep the route template small and bounded to avoid
// label cardinality blow-up. The 'route' label is the pattern, not the
// actual path.
func HTTPMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(recorder, r)

		route := routeLabel(r.URL.Path)
		httpRequests.WithLabelValues(route, r.Method, strconv.Itoa(recorder.status)).Inc()
		httpDuration.WithLabelValues(route, r.Method).Observe(time.Since(start).Seconds())
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// routeLabel collapses high-cardinality paths to safe labels. Anything
// matching common patterns (workspace IDs, host IDs, etc.) becomes
// "{id}" so we don't blow up Prometheus with one series per request.
// We only collapse the first dynamic segment per path; subsequent dynamic
// segments are treated the same way. Static trailing suffixes are kept so
// operators can still see, e.g., "/api/workspace/{id}/projects".
func routeLabel(p string) string {
	segments := strings.Split(p, "/")
	changed := false
	for i, s := range segments {
		// Treat segments of 16+ chars or pure-hex 16+ as IDs. This catches
		// UUIDs, nanoids, and hex hashes without mis-classifying normal
		// words like "provision" or "replication".
		if len(s) >= 16 && isIDLike(s) {
			segments[i] = "{id}"
			changed = true
		}
	}
	if !changed {
		return p
	}
	return strings.Join(segments, "/")
}

func isIDLike(s string) bool {
	digits, alpha := 0, 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= '0' && c <= '9':
			digits++
		case (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'):
			alpha++
		default:
			return false
		}
	}
	// IDs are dominated by alphanumerics. Pure words like "configuration"
	// have alpha>=16 but very few digits; require a mix.
	return digits >= 4 && alpha >= 4
}