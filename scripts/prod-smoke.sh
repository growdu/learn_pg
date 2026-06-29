#!/usr/bin/env bash
# Bring up the prod compose against a prebuilt backend image and curl
# the public surface. Mirrors scripts/dev-smoke.sh but for the
# production stack — exercises:
#   * the multi-stage prod Dockerfile output (read-only rootfs,
#     non-root user, minimal alpine runtime, drop caps)
#   * the production nginx config (deploy/nginx/nginx.conf)
#   * the prod compose wiring (postgres + backend + frontend)
#
# Image policy:
#   This script does NOT build the backend image. The Dockerfile's
#   runtime stage downloads docker-compose v2.24.0 from GitHub on
#   every cold build, and that step is unreliable in CI / behind
#   proxies (see Dockerfile step 'apk add ... && wget ...'). The
#   build belongs in the Dockerfile itself; once `learn_pg-backend:
#   latest` is present (locally via `make build` or in CI via
#   backend-build), this script just validates the prod compose stack.
#
#   To rebuild the prod image, run from the repo root:
#     docker build -t learn_pg-backend:latest \
#       -f backend/Dockerfile backend/ \
#       --build-arg VERSION=... --build-arg COMMIT=... \
#       --build-arg BUILD_DATE=... --build-arg GO_VERSION=...
#
# Teardown: always stops and removes the compose project, even on
# failure. Safe to re-run; uses project name 'pgv-smoke'.
#
# Requires: docker compose v2, curl, the learn_pg-backend:latest
# image already built locally.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
COMPOSE_FILE="$ROOT/docker-compose.prod.yml"
OVERRIDE_FILE="$HERE/docker-compose.prod-smoke.yml"
PROJECT_NAME="pgv-smoke"
BACKEND_IMAGE="learn_pg-backend:latest"

HOST_PG_PORT=15432
HOST_API_PORT=13010
HOST_FE_PORT=13080

cleanup() {
  docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" -f "$OVERRIDE_FILE" \
    down --remove-orphans --volumes --timeout 30 >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "=== checking backend image ==="
if ! docker image inspect "$BACKEND_IMAGE" >/dev/null 2>&1; then
  echo "ERROR: $BACKEND_IMAGE not present locally."
  echo "Build it first, e.g.:"
  echo "  docker build -t $BACKEND_IMAGE -f backend/Dockerfile backend/ \\"
  echo "    --build-arg VERSION=dev --build-arg COMMIT=\$(git rev-parse --short HEAD) \\"
  echo "    --build-arg BUILD_DATE=\$(date -u +%Y-%m-%dT%H:%M:%SZ) \\"
  echo "    --build-arg GO_VERSION=\$(go version | awk '{print \$3}')"
  exit 1
fi
echo "  using $BACKEND_IMAGE ($(docker image inspect --format '{{.Size}}' "$BACKEND_IMAGE" | numfmt --to=iec))"

echo
echo "=== validating compose config ==="
docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" -f "$OVERRIDE_FILE" \
  config --quiet || { echo "compose config invalid"; exit 1; }

echo
echo "=== starting services ==="
docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" -f "$OVERRIDE_FILE" \
  up -d --wait --wait-timeout 180

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
check_http "http://localhost:$HOST_API_PORT/health"           "backend /health"
check_http "http://localhost:$HOST_API_PORT/api/workspace/projects" "backend /api/workspace/projects"
# /version is informational; if the image is stale (e.g. you just
# updated the source but haven't rebuilt learn_pg-backend:latest) it
# returns 404. Don't fail the smoke on it — log a warning instead.
code=$(curl -s -o /tmp/smoke.body -w "%{http_code}" "http://localhost:$HOST_API_PORT/version" || echo "000")
if [ "$code" = "200" ]; then
  printf "  %-40s OK    (200, %s bytes)\n" "backend /version" "$(wc -c < /tmp/smoke.body)"
else
  printf "  %-40s WARN  (status=%s, image may be stale)\n" "backend /version" "$code"
fi
check_http "http://localhost:$HOST_FE_PORT/"                  "frontend / (nginx)"

echo
echo "=== teardown ==="
cleanup

if [ "$fail" -ne 0 ]; then
  echo "PROD SMOKE FAILED"
  exit 1
fi
echo "PROD SMOKE OK"
