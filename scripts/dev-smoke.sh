#!/usr/bin/env bash
# Run the dev compose end-to-end on non-default ports and curl the
# public surface. Verifies:
#   * docker-compose.dev.yml still composes cleanly with our override
#   * postgres, backend, frontend all start and become reachable
#   * the backend actually serves the workspace API
#   * nginx serves the static frontend
#
# Teardown: always stops and removes the compose project, even on
# failure. Safe to re-run; uses project name 'pgv-smoke' so it never
# collides with a real 'learn_pg' deployment.
#
# Requires: docker compose v2, curl.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
COMPOSE_FILE="$ROOT/docker-compose.dev.yml"
OVERRIDE_FILE="$HERE/docker-compose.smoke.yml"
PROJECT_NAME="pgv-smoke"

HOST_PG_PORT=15433
HOST_API_PORT=13010
HOST_FE_PORT=13001

cleanup() {
  docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" -f "$OVERRIDE_FILE" \
    down --remove-orphans --volumes --timeout 30 >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "=== validating compose config ==="
docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" -f "$OVERRIDE_FILE" \
  config --quiet || { echo "compose config invalid"; exit 1; }

echo "=== starting services (no linux-only profile = no collector) ==="
docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" -f "$OVERRIDE_FILE" \
  up -d --build --wait --wait-timeout 120

echo
echo "=== smoke checks ==="
fail=0

check_http() {
  local url="$1"
  local label="$2"
  local code
  code=$(curl -s -o /tmp/smoke.body -w "%{http_code}" "$url" || echo "000")
  if [ "$code" = "200" ]; then
    printf "  %-40s OK  (200, %s bytes)\n" "$label" "$(wc -c < /tmp/smoke.body)"
  else
    printf "  %-40s FAIL  (status=%s)\n" "$label" "$code"
    [ -s /tmp/smoke.body ] && head -5 /tmp/smoke.body | sed 's/^/    /'
    fail=1
  fi
}

check_http "http://localhost:$HOST_API_PORT/livez"            "backend /livez"
check_http "http://localhost:$HOST_API_PORT/version"          "backend /version"
check_http "http://localhost:$HOST_API_PORT/health"           "backend /health"
check_http "http://localhost:$HOST_API_PORT/api/workspace/projects" "backend /api/workspace/projects"
check_http "http://localhost:$HOST_API_PORT/metrics"          "backend /metrics"
check_http "http://localhost:$HOST_FE_PORT/"                  "frontend / (nginx)"

echo
echo "=== teardown ==="
cleanup

if [ "$fail" -ne 0 ]; then
  echo "SMOKE FAILED"
  exit 1
fi
echo "SMOKE OK"
