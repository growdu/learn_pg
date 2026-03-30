package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"pg-visualizer-backend/internal/api"
	"pg-visualizer-backend/internal/config"
	"pg-visualizer-backend/internal/ws"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)

	// Load configuration from environment
	cfg := config.Load()

	log.Printf("[MAIN] PG Kernel Visualizer Backend")
	log.Printf("[MAIN] Config: PG=%s:%d, API=%d, WS=%d",
		cfg.PGHost, cfg.PGPort, cfg.APIPort, cfg.WSPort)

	// Create WebSocket hub
	hub := ws.NewHub()
	go hub.Run()
	log.Printf("[MAIN] WebSocket Hub started")

	// Create API handler
	handler := api.NewHandler(cfg, hub)

	// Setup HTTP router
	mux := http.NewServeMux()
	api.SetupRoutes(handler, mux)

	// Start combined HTTP+WS server
	addr := fmt.Sprintf(":%d", cfg.APIPort)
	log.Printf("[MAIN] Backend ready. API+WS=http://localhost:%d", cfg.APIPort)

	go func() {
		if err := http.ListenAndServe(addr, mux); err != nil {
			log.Fatalf("[MAIN] Server failed: %v", err)
		}
	}()

	// Wait for shutdown signal
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	log.Printf("[MAIN] Shutting down...")
}