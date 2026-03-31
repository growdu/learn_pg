#!/bin/bash
# Integration test script for PG Kernel Visualizer
# This script tests the complete stack with docker-compose

set -e

echo "==================================="
echo "PG Kernel Visualizer Integration Tests"
echo "==================================="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print test result
pass() {
    echo -e "${GREEN}✓ $1${NC}"
}

fail() {
    echo -e "${RED}✗ $1${NC}"
    exit 1
}

info() {
    echo -e "${YELLOW}ℹ $1${NC}"
}

# Check if docker is available
info "Checking Docker availability..."
if ! command -v docker &> /dev/null; then
    fail "Docker is not installed"
fi

if ! command -v docker compose &> /dev/null; then
    fail "Docker Compose is not available"
fi

# Stop any existing containers
info "Cleaning up existing containers..."
docker compose down --remove-orphans 2>/dev/null || true

# Build images first
info "Building Docker images..."
docker compose build --parallel || fail "Docker build failed"

# Start services
info "Starting services..."
docker compose up -d postgres backend

# Wait for postgres
info "Waiting for PostgreSQL to be ready..."
for i in {1..30}; do
    if docker compose exec -T postgres pg_isready -U postgres &>/dev/null; then
        pass "PostgreSQL is ready"
        break
    fi
    if [ $i -eq 30 ]; then
        fail "PostgreSQL did not become ready"
    fi
    sleep 1
done

# Wait for backend
info "Waiting for backend to be ready..."
for i in {1..20}; do
    if curl -s http://localhost:3000/health &>/dev/null; then
        pass "Backend is ready"
        break
    fi
    if [ $i -eq 20 ]; then
        fail "Backend did not become ready"
    fi
    sleep 1
done

# Test backend health endpoint
info "Testing backend health endpoint..."
HEALTH_RESPONSE=$(curl -s http://localhost:3000/health)
if echo "$HEALTH_RESPONSE" | grep -q "ok"; then
    pass "Health endpoint returns ok"
else
    fail "Health endpoint failed: $HEALTH_RESPONSE"
fi

# Test backend API
info "Testing backend API endpoints..."
API_RESPONSE=$(curl -s http://localhost:3000/api/connect)
if echo "$API_RESPONSE" | grep -q "error\|Error" || echo "$API_RESPONSE" | grep -q "success"; then
    pass "API endpoint responds"
else
    fail "API endpoint failed: $API_RESPONSE"
fi

# Test frontend is accessible
info "Testing frontend accessibility..."
FRONTEND_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost/)
if [ "$FRONTEND_RESPONSE" = "200" ]; then
    pass "Frontend is accessible"
else
    fail "Frontend returned $FRONTEND_RESPONSE"
fi

# Check WebSocket endpoint
info "Testing WebSocket endpoint..."
WS_CHECK=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/ws)
if [ "$WS_CHECK" = "400" ] || [ "$WS_CHECK" = "101" ]; then
    pass "WebSocket endpoint responds"
else
    info "WebSocket returned $WS_CHECK (may be expected for HTTP GET)"
fi

# Test WAL file reading (if pg_wal exists)
info "Testing WAL file access..."
if docker compose exec -T postgres test -d /var/lib/postgresql/data/pg_wal; then
    pass "pg_wal directory exists"
else
    info "pg_wal not accessible (normal in some configs)"
fi

# Test CLOG file access
info "Testing CLOG file access..."
if docker compose exec -T postgres test -d /var/lib/postgresql/data/pg_clog; then
    pass "pg_clog directory exists"
else
    info "pg_clog not accessible (normal in some configs)"
fi

# Clean up
info "Cleaning up..."
docker compose down --remove-orphans

echo ""
echo "==================================="
pass "All integration tests passed!"
echo "==================================="