package main

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"pg-visualizer-backend/internal/api"
	"pg-visualizer-backend/internal/auditlog"
	"pg-visualizer-backend/internal/config"
	"pg-visualizer-backend/internal/connection"
	"pg-visualizer-backend/internal/middleware"
	"pg-visualizer-backend/internal/metrics"
	"pg-visualizer-backend/internal/ratelimit"
	"pg-visualizer-backend/internal/reporter"
	"pg-visualizer-backend/internal/ws"
)

func main() {
	// Structured logger — JSON to stdout (production-friendly)
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	})))

	cfg := config.Load()
	slog.Info("PG Kernel Visualizer Backend starting",
		"pg_host", cfg.PGHost,
		"pg_port", cfg.PGPort,
		"api_port", cfg.APIPort,
		"log_level", cfg.LogLevel,
	)

	// Create WebSocket hub. Same origin allowlist as the HTTP CORS
	// middleware (parsed below from CORS_ALLOWED_ORIGINS), so a
	// browser that can call the API can also open the WS stream.
	hub := ws.NewHub(parseAllowedOrigins())
	go hub.Run()
	slog.Info("WebSocket Hub started")

	// Create connection manager
	connMgr := connection.NewManager(cfg)

	// Create API handler
	handler := api.NewHandler(cfg, hub, connMgr)

	// Auto-connect to PostgreSQL on startup
	if cfg.PGHost != "" {
		connMgr.Register("__auto__", connection.Config{
			Host:     cfg.PGHost,
			Port:     cfg.PGPort,
			User:     cfg.PGUser,
			Password: cfg.PGPassword,
			Database: cfg.PGDatabase,
		})
		if err := connMgr.Activate("__auto__"); err != nil {
			slog.Warn("auto-connect to PG failed, use /api/connect to connect later",
				"error", err)
		} else {
			if nodeId, client := connMgr.GetActive(); client != nil {
				if v, err := client.GetVersion(); err == nil {
					slog.Info("PostgreSQL connected", "node", nodeId, "version", v)
				}
			}
		}
	}

	// Build router with middleware chain
	mux := http.NewServeMux()
	api.SetupRoutes(handler, mux)

	// Error reporter. No-op when REPORT_DSN is empty. We pull
	// the project name from APP_ENV and the build version from
	// APP_RELEASE (set by the same -ldflags as metrics.BuildInfo).
	rep := reporter.New(reporter.Config{
		DSN:         os.Getenv("REPORT_DSN"),
		Environment: os.Getenv("APP_ENV"),
		Release:     os.Getenv("APP_RELEASE"),
	})
	defer rep.Shutdown()

	// Audit log: a dedicated slog channel for sensitive operations
	// (PG connect, execute, provision, workspace edits, discovery
	// imports). Path is "-" to write to stderr alongside the regular
	// log; set LEARN_PG_AUDIT_PATH to point at a file or a
	// fifo consumed by a log shipper.
	auditPath := os.Getenv("LEARN_PG_AUDIT_PATH")
	if auditPath == "" {
		auditPath = "-"
	}
	auditLogger, err := auditlog.New(auditPath)
	if err != nil {
		slog.Error("audit logger init failed; continuing without audit", "err", err.Error())
	} else {
		handler.SetAuditLog(auditLogger)
		defer auditLogger.Close()
	}

	// Graceful shutdown for the telemetry store — flushes the dedup
	// map to disk so a restart doesn't lose accumulated counts.
	defer func() {
		if err := handler.CloseTelemetry(); err != nil {
			slog.Warn("telemetry store close failed", "err", err.Error())
		}
	}()

	// Per-IP token-bucket rate limiter. Health/metrics/ws/version are exempt.
	rateLimiter := ratelimit.New(ratelimit.Options{
		Capacity:        60,
		RefillPerSecond: 20,
	})

	// Middleware stack — outer → inner, so request flow is:
	//   RequestID → Logger → CORS → Security → RateLimit → Metrics → mux
	// Order rationale:
	//   - RequestID outermost so every log/metric/response carries the id.
	//   - Logger next so it sees the final status (set by inner middleware
	//     like RateLimit responding 429).
	//   - CORS early so preflight OPTIONS never hits a 429.
	//   - Security sets headers before any handler runs.
	//   - RateLimit returns 429 *without* invoking downstream — that's why
	//     it sits after Security (so 429 responses still get hardened).
	//   - Metrics innermost so it sees the original handler status.
	var finalHandler http.Handler = mux
	finalHandler = middleware.Recover(rep)(finalHandler)
	finalHandler = middleware.RequestID(finalHandler)
	finalHandler = middleware.Logger(finalHandler)
	corsCfg := middleware.DefaultCORSConfig()
	if v := os.Getenv("CORS_ALLOWED_ORIGINS"); v != "" {
		// Comma-separated whitelist. "*" alone is a wildcard.
		corsCfg.AllowedOrigins = splitAndTrim(v, ",")
	}
	if os.Getenv("CORS_ALLOW_CREDENTIALS") == "true" {
		corsCfg.AllowCredentials = true
	}
	finalHandler = middleware.CORS(corsCfg)(finalHandler)
	finalHandler = middleware.Security(finalHandler)
	finalHandler = rateLimiter.Middleware(finalHandler)
	finalHandler = metrics.HTTPMiddleware(finalHandler)
	// Recover is outermost (wraps the chain) so it catches panics
	// from any inner middleware, not just the route handler. The
	// reporter pushes the event to Sentry in a goroutine so the
	// response is never delayed.

	// HTTP server with timeouts
	addr := fmt.Sprintf(":%d", cfg.APIPort)
	srv := &http.Server{
		Addr:         addr,
		Handler:      finalHandler,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Start server in goroutine
	go func() {
		slog.Info("server listening", "addr", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("server failed", "error", err)
			os.Exit(1)
		}
	}()

	// Graceful shutdown on SIGINT/SIGTERM
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	sig := <-sigChan

	slog.Info("shutdown signal received", "signal", sig)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Stop the HTTP server first so no new requests come in.
	if err := srv.Shutdown(ctx); err != nil {
		slog.Error("server shutdown error", "error", err)
	}

	// Close downstream resources in the reverse order they were
	// started. Each step has its own bounded timeout so a stuck
	// dependency can't pin the process forever.
	hub.Stop()
	connMgr.Close()

	slog.Info("server stopped")
}

// splitAndTrim splits s on sep, trims whitespace and drops empty parts.
func splitAndTrim(s, sep string) []string {
	parts := strings.Split(s, sep)
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// parseAllowedOrigins returns the WS / CORS origin allowlist derived
// from CORS_ALLOWED_ORIGINS. An empty env var yields the wildcard
// default so a deployer who hasn't set the var (e.g. local dev) gets
// the same behaviour as before this refactor.
func parseAllowedOrigins() []string {
	v := os.Getenv("CORS_ALLOWED_ORIGINS")
	if v == "" {
		return []string{"*"}
	}
	return splitAndTrim(v, ",")
}
