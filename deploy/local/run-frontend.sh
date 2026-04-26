#!/bin/bash
# Local frontend startup script
# Requires: Node.js and npm installed locally

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
BACKEND_API_PORT="${BACKEND_API_PORT:-3000}"
FRONTEND_PORT="${FRONTEND_PORT:-80}"

echo "=== Starting frontend locally ==="
echo "Frontend Port: $FRONTEND_PORT"
echo "Backend API: $BACKEND_API_PORT"
echo "Backend WebSocket: ws://localhost:$BACKEND_API_PORT/ws"

# Build frontend if needed
if [ ! -d "$PROJECT_ROOT/frontend/dist" ]; then
    echo "Building frontend..."
    cd "$PROJECT_ROOT/frontend"
    npm install
    npm run build
fi

# Start nginx or simple HTTP server
echo "Starting frontend on port $FRONTEND_PORT..."

# Check if nginx is available
if command -v nginx &> /dev/null; then
    # Use nginx with custom config
    sudo nginx -c "$SCRIPT_DIR/nginx.conf"
else
    # Use Python's simple HTTP server as fallback
    cd "$PROJECT_ROOT/frontend/dist"
    python3 -m http.server "$FRONTEND_PORT"
fi
