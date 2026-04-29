package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"pg-visualizer-backend/internal/api"
	"pg-visualizer-backend/internal/config"
	"pg-visualizer-backend/internal/middleware"
	"pg-visualizer-backend/internal/pg"
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

	// Create WebSocket hub
	hub := ws.NewHub()
	go hub.Run()
	slog.Info("WebSocket Hub started")

	// Create API handler
	handler := api.NewHandler(cfg, hub)

	// Auto-connect to PostgreSQL on startup
	if cfg.PGHost != "" {
		client := pg.NewClient()
		if err := client.Connect(cfg.PGHost, cfg.PGPort, cfg.PGUser, cfg.PGPassword, cfg.PGDatabase); err != nil {
			slog.Warn("auto-connect to PG failed, use /api/connect to connect later",
				"error", err)
		} else {
			handler.SetPGClient(client)
			if v, err := client.GetVersion(); err == nil {
				slog.Info("PostgreSQL connected", "version", v)
			}
		}
	}

	// Build router with middleware chain
	mux := http.NewServeMux()
	api.SetupRoutes(handler, mux)

	// Middleware stack — each wraps the one before.
	// Execution: CORS → Logger → RequestID → mux
	// Logger is before RequestID so it reads the X-Request-Id response header
	// that RequestID set (Go's ResponseWriter.Header and Request.Header are
	// separate maps, so w.Header().Set() is not visible via r.Header.Get()).
	var finalHandler http.Handler = mux
	finalHandler = middleware.RequestID(finalHandler)
	finalHandler = middleware.Logger(finalHandler)
	finalHandler = middleware.CORS(finalHandler)

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

	// Give active connections 10s to finish
	if err := srv.Shutdown(ctx); err != nil {
		slog.Error("server shutdown error", "error", err)
	}

	slog.Info("server stopped")
}
