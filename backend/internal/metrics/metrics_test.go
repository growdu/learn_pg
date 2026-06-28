package metrics

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestRouteLabel(t *testing.T) {
	cases := []struct{ in, want string }{
		{"/health", "/health"},
		{"/api/discovery/dsn/validate", "/api/discovery/dsn/validate"},
		{"/api/workspace/projects/abc123def4567890abcdef/projects", "/api/workspace/projects/{id}/projects"},
		{"/api/workspace/abc/cluster/def/clusters", "/api/workspace/abc/cluster/def/clusters"},
	}
	for _, c := range cases {
		if got := routeLabel(c.in); got != c.want {
			t.Errorf("routeLabel(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestHTTPMiddlewareRecordsMetrics(t *testing.T) {
	before := readCounter(t, `pgv_http_requests_total{method="GET",route="/x",status="200"}`)

	h := HTTPMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 200 {
		t.Fatalf("status = %d", rr.Code)
	}

	after := readCounter(t, `pgv_http_requests_total{method="GET",route="/x",status="200"}`)
	if after-before < 1 {
		t.Fatalf("counter did not increment: before=%g after=%g", before, after)
	}
}

func readCounter(t *testing.T, prefix string) float64 {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	rr := httptest.NewRecorder()
	Handler().ServeHTTP(rr, req)
	if rr.Code != 200 {
		t.Fatalf("/metrics returned %d", rr.Code)
	}
	for _, line := range strings.Split(rr.Body.String(), "\n") {
		if !strings.HasPrefix(line, prefix) {
			continue
		}
		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}
		f, err := strconv.ParseFloat(parts[len(parts)-1], 64)
		if err != nil {
			t.Fatalf("parse %q: %v", parts[len(parts)-1], err)
		}
		return f
	}
	return 0
}

// silence unused-import vet warning
var _ = fmt.Sprintf
