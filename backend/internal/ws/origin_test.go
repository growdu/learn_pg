package ws

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// helper: build a synthetic WS upgrade request with the given Origin
// header (may be empty).
func reqWithOrigin(origin string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/ws", nil)
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	return r
}

func TestCheckOrigin_NoOrigin_AlwaysAllowed(t *testing.T) {
	// Non-browser clients (curl, ws cli, the eBPF collector) don't
	// send Origin; the upgrader must accept them regardless of the
	// allowlist.
	check := buildCheckOrigin([]string{"https://allowed.example.com"})
	if !check(reqWithOrigin("")) {
		t.Fatal("empty Origin should be allowed (non-browser client)")
	}
}

func TestCheckOrigin_Wildcard(t *testing.T) {
	check := buildCheckOrigin([]string{"*"})
	for _, o := range []string{
		"https://evil.example.com",
		"http://localhost:3000",
		"https://app.production.example.com",
	} {
		if !check(reqWithOrigin(o)) {
			t.Errorf("wildcard should accept %q", o)
		}
	}
}

func TestCheckOrigin_EmptyAllowlistIsWildcard(t *testing.T) {
	// Matches the CORS middleware's "no config → wildcard" default so
	// a deployer who hasn't set CORS_ALLOWED_ORIGINS keeps the
	// pre-refactor behaviour.
	check := buildCheckOrigin(nil)
	if !check(reqWithOrigin("https://anything.example.com")) {
		t.Fatal("nil allowlist should be a wildcard")
	}
}

func TestCheckOrigin_AllowlistEnforced(t *testing.T) {
	check := buildCheckOrigin([]string{
		"https://app.example.com",
		"https://admin.example.com",
	})
	cases := []struct {
		origin string
		want   bool
	}{
		{"https://app.example.com", true},
		{"https://admin.example.com", true},
		{"https://evil.example.com", false},
		{"http://app.example.com", false},    // scheme mismatch
		{"https://app.example.com:8443", false}, // port mismatch
		{"", true},                            // non-browser
	}
	for _, c := range cases {
		got := check(reqWithOrigin(c.origin))
		if got != c.want {
			t.Errorf("origin=%q: got %v, want %v", c.origin, got, c.want)
		}
	}
}

func TestCheckOrigin_CaseInsensitive(t *testing.T) {
	// Browsers always send a normalized Origin, but we still don't
	// want a trivial case difference to lock the user out.
	check := buildCheckOrigin([]string{"https://APP.example.com"})
	if !check(reqWithOrigin("https://app.EXAMPLE.com")) {
		t.Fatal("Origin matching should be case-insensitive on the host")
	}
}
