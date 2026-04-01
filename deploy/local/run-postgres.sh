#!/bin/bash
# Local PostgreSQL startup script
# Requires: PostgreSQL installed locally

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
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-postgres}"
PG_DATA_DIR="${PG_DATA_DIR:-/var/lib/postgresql/data}"

echo "=== Starting PostgreSQL locally ==="
echo "Port: $POSTGRES_PORT"
echo "Data directory: $PG_DATA_DIR"

# Check if PostgreSQL is installed
if ! command -v pg_ctl &> /dev/null; then
    echo "Error: PostgreSQL not found. Please install PostgreSQL first."
    exit 1
fi

# Initialize data directory if not exists
if [ ! -d "$PG_DATA_DIR" ]; then
    echo "Initializing PostgreSQL data directory..."
    initdb -D "$PG_DATA_DIR"
fi

# Start PostgreSQL
echo "Starting PostgreSQL..."
pg_ctl -D "$PG_DATA_DIR" -l "$PG_DATA_DIR/logfile" start

# Wait for PostgreSQL to be ready
echo "Waiting for PostgreSQL to be ready..."
for i in {1..30}; do
    if pg_isready -p "$POSTGRES_PORT" &> /dev/null; then
        echo "PostgreSQL is ready!"
        exit 0
    fi
    sleep 1
done

echo "Error: PostgreSQL failed to start"
exit 1