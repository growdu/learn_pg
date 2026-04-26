package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"pg-visualizer-backend/internal/api"
	"pg-visualizer-backend/internal/config"
	"pg-visualizer-backend/internal/pg"
	"pg-visualizer-backend/internal/ws"
)

// CORS middleware
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)

	// Load configuration from environment
	cfg := config.Load()

	log.Printf("[MAIN] PG Kernel Visualizer Backend")
	log.Printf("[MAIN] Config: PG=%s:%d, API=%d",
		cfg.PGHost, cfg.PGPort, cfg.APIPort)

	// Create WebSocket hub
	hub := ws.NewHub()
	go hub.Run()
	log.Printf("[MAIN] WebSocket Hub started")

	// Create API handler
	handler := api.NewHandler(cfg, hub)

	// Auto-connect to PostgreSQL on startup
	if cfg.PGHost != "" {
		client := pg.NewClient()
		if err := client.Connect(cfg.PGHost, cfg.PGPort, cfg.PGUser, cfg.PGPassword, cfg.PGDatabase); err != nil {
			log.Printf("[MAIN] WARNING: auto-connect to PG failed: %v (use /api/connect to connect later)", err)
		} else {
			handler.SetPGClient(client)
			if v, err := client.GetVersion(); err == nil {
				log.Printf("[MAIN] PostgreSQL connected: %s", v)
			}
		}
	}

	// Setup HTTP router
	mux := http.NewServeMux()
	api.SetupRoutes(handler, mux)

	// Wrap mux with CORS middleware
	corsHandler := corsMiddleware(mux)

	// Start combined HTTP+WS server
	addr := fmt.Sprintf(":%d", cfg.APIPort)
	log.Printf("[MAIN] Backend ready. API+WS=http://localhost:%d", cfg.APIPort)

	go func() {
		server := &http.Server{
			Addr:         addr,
			Handler:      corsHandler,
			ReadTimeout:  30 * time.Second,
			WriteTimeout: 30 * time.Second,
		}
		if err := server.ListenAndServe(); err != nil {
			log.Fatalf("[MAIN] Server failed: %v", err)
		}
	}()

	// Wait for shutdown signal
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	log.Printf("[MAIN] Shutting down...")
}