package config

import (
	"os"
	"strconv"
)

// Config holds all configuration for the application
type Config struct {
	// PostgreSQL
	PGHost     string
	PGPort     int
	PGUser     string
	PGPassword string
	PGDatabase string
	PGDataDir  string

	// Backend
	APIPort int
	WSPort  int

	// Collector
	CollectorWSURL string
	EnableEBPF    bool

	// Logging
	LogLevel string
}

// Load reads configuration from environment variables
func Load() *Config {
	return &Config{
		PGHost:          getEnv("PG_HOST", "localhost"),
		PGPort:          getEnvInt("PG_PORT", 5432),
		PGUser:          getEnv("PG_USER", "postgres"),
		PGPassword:      getEnv("PG_PASSWORD", "postgres"),
		PGDatabase:      getEnv("PG_DATABASE", "postgres"),
		PGDataDir:       getEnv("PG_DATA_DIR", "/var/lib/postgresql/data"),
		APIPort:         getEnvInt("API_PORT", 3000),
		WSPort:          getEnvInt("WS_PORT", 8080),
		CollectorWSURL:  getEnv("COLLECTOR_WS_URL", "ws://localhost:8090"),
		EnableEBPF:      getEnvBool("ENABLE_EBPF", true),
		LogLevel:        getEnv("LOG_LEVEL", "info"),
	}
}

func getEnv(key, defaultValue string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultValue
}

func getEnvInt(key string, defaultValue int) int {
	if v := os.Getenv(key); v != "" {
		if i, err := strconv.Atoi(v); err == nil {
			return i
		}
	}
	return defaultValue
}

func getEnvBool(key string, defaultValue bool) bool {
	if v := os.Getenv(key); v != "" {
		if v == "true" || v == "1" {
			return true
		}
		return false
	}
	return defaultValue
}