# Build stage
FROM docker.m.daocloud.io/library/golang:1.24-alpine AS builder

# Use Chinese Go proxy
ENV GOPROXY=https://goproxy.cn,direct
ENV GO111MODULE=on
ENV GOSUMDB=off
# Allow GOTOOLCHAIN=auto so the build can pick up the go.mod toolchain
# (go1.24.2) even if the base image is slightly behind.
ENV GOTOOLCHAIN=auto

RUN apk add --no-cache ca-certificates git

WORKDIR /app

# Copy go mod files first for better caching
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build
ARG VERSION=dev
ARG COMMIT=unknown
ARG BUILD_DATE=unknown
ARG GO_VERSION=dev
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo \
    -ldflags "-X pg-visualizer-backend/internal/metrics.BuildInfo.Version=${VERSION} \
              -X pg-visualizer-backend/internal/metrics.BuildInfo.Commit=${COMMIT} \
              -X pg-visualizer-backend/internal/metrics.BuildInfo.BuildDate=${BUILD_DATE} \
              -X pg-visualizer-backend/internal/metrics.BuildInfo.GoVersion=${GO_VERSION} \
              -s -w" \
    -o server ./cmd/server

# Production stage
FROM docker.m.daocloud.io/library/alpine:3.19

# tini: a tiny init that forwards signals and reaps zombies. Without
# it, a shell-less Go binary becomes PID 1 and inherits orphaned
# children (zombies) because the kernel won't deliver SIGCHLD to a
# non-init process. It's also the only correct way to handle SIGTERM
# propagation in Kubernetes/docker stop with a 10s grace period.
#
# docker-cli + compose: needed by the provision flow which spawns
# containers via the host's docker socket. We prefer a SHA256-locked
# pinned docker-compose v2.24.0 for reproducibility, but fall back to
# the Alpine-packaged version (currently v2.23.3) when the GitHub
# release download is blocked or slow. The fallback keeps the image
# buildable in restricted networks at the cost of a one-minor-version
# drift; compose's CLI surface is stable across 2.23.x and 2.24.x.
RUN apk add --no-cache ca-certificates tini docker-cli docker-cli-compose wget && \
    set -eux; \
    COMPOSE_VERSION=v2.24.0; \
    COMPOSE_SHA256=ce4630d1720dc4b2f2da387c90c46017fcf3d8e87287c64191e2f6e904bb1b0e; \
    COMPOSE_URL="https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64"; \
    if wget --tries=1 --timeout=20 -q "${COMPOSE_URL}" -O /usr/local/bin/docker-compose-pin && \
       echo "${COMPOSE_SHA256}  /usr/local/bin/docker-compose-pin" | sha256sum -c -; then \
      mv /usr/local/bin/docker-compose-pin /usr/local/bin/docker-compose; \
      chmod +x /usr/local/bin/docker-compose; \
      echo "using pinned docker-compose ${COMPOSE_VERSION}"; \
    else \
      echo "WARNING: pinned docker-compose download failed, falling back to apk package"; \
      rm -f /usr/local/bin/docker-compose-pin; \
      # docker-cli-compose installs the plugin into /usr/libexec/docker/cli-plugins
      # but `docker compose` also looks in /usr/local/lib/docker/cli-plugins.
      # The apk package provides the plugin; nothing to copy. \
    fi

# Drop privileges. The server still needs to talk to the docker
# socket (/var/run/docker.sock) - that's why this isn't a distroless
# image - but everything else is now UID 65532.
RUN addgroup -g 65532 -S app && adduser -u 65532 -S app -G app

WORKDIR /app

COPY --from=builder --chown=app:app /app/server /app/server

# Data dir: scratch space for workspace.json, provision manifests.
# Owned by app so the server can write to it without root.
RUN mkdir -p /app/data && chown -R app:app /app

USER app:app

EXPOSE 3000

# /livez never touches the disk so it can't false-negative on a
# read-only filesystem.
HEALTHCHECK --interval=10s --timeout=3s --retries=3 --start-period=5s \
    CMD wget -qO- http://localhost:3000/livez || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/app/server"]
