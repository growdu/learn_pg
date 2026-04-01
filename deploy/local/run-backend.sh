#!/bin/bash
# Local backend startup script
# Requires: Go installed locally

set -e

# Load environment variables
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Source .env if exists
if [ -f "$PROJECT_ROOT/.env" ]; then
    set -a
    source "$PROJECT_ROOT/.env"
    set +a
fi

# Default values
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-postgres}"
BACKEND_API_PORT="${BACKEND_API_PORT:-3000}"
BACKEND_WS_PORT="${BACKEND_WS_PORT:-8080}"
COLLECTOR_WS_URL="${COLLECTOR_WS_URL:-ws://localhost:8090}"
PG_DATA_DIR="${PG_DATA_DIR:-/var/lib/postgresql/data}"

echo "=== Starting backend locally ==="
echo "API Port: $BACKEND_API_PORT"
echo "WebSocket Port: $BACKEND_WS_PORT"
echo "PostgreSQL: $POSTGRES_HOST:$POSTGRES_PORT"

# Build backend if needed
BACKEND_BIN="$PROJECT_ROOT/backend/server"
if [ ! -f "$BACKEND_BIN" ] || [ "$PROJECT_ROOT/backend" -nt "$BACKEND_BIN" ]; then
    echo "Building backend..."
    cd "$PROJECT_ROOT/backend"
    go build -o "$BACKEND_BIN" ./cmd/server
fi

# Set environment variables
export PG_HOST="$POSTGRES_HOST"
export PG_PORT="$POSTGRES_PORT"
export PG_USER="$POSTGRES_USER"
export PG_PASSWORD="$POSTGRES_PASSWORD"
export PG_DATABASE="$POSTGRES_DB"
export API_PORT="$BACKEND_API_PORT"
export WS_PORT="$BACKEND_WS_PORT"
export COLLECTOR_WS_URL="$COLLECTOR_WS_URL"
export PG_DATA_DIR="$PG_DATA_DIR"

# Start backend
echo "Starting backend..."
exec "$BACKEND_BIN"