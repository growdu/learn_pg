package middleware

import (
	"log/slog"
	"net/http"
	"runtime/debug"

	"pg-visualizer-backend/internal/reporter"
)

// Recover catches panics in downstream handlers, reports them to the
// reporter (if any), logs a structured error, and returns a 500 so
// the client sees a clean response rather than a connection drop.
//
// It must wrap the inner handler stack so that panics in any
// downstream middleware (not just the route handler) are caught.
func Recover(r *reporter.Reporter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			defer func() {
				rec := recover()
				if rec == nil {
					return
				}
				stack := string(debug.Stack())
				slog.Error("panic in handler",
					"path", req.URL.Path,
					"method", req.Method,
					"recovered", rec,
					"stack", stack,
				)
				if r != nil && r.Enabled() {
					// Best-effort: report the panic to the reporter
					// without blocking the response.
					go r.CaptureError(&panicError{value: rec, stack: stack})
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusInternalServerError)
				w.Write([]byte(`{"error":"internal server error"}`))
			}()
			next.ServeHTTP(w, req)
		})
	}
}

// panicError lets reporter.CaptureError treat a recovered value as
// an error. The error string includes the panic value and a stack
// trace for triage.
type panicError struct {
	value interface{}
	stack string
}

func (p *panicError) Error() string {
	return "panic: " + asString(p.value)
}

func asString(v interface{}) string {
	if s, ok := v.(string); ok {
		return s
	}
	return slog.AnyValue(v).String()
}
