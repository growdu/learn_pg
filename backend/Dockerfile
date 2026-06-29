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
# containers via the host's docker socket. We pin both to a specific
# version+SHA256 so a compromised upstream can't silently swap the
# binary at build time.
RUN apk add --no-cache ca-certificates tini docker-cli wget && \
    set -eux; \
    COMPOSE_VERSION=v2.24.0; \
    COMPOSE_SHA256=ce4630d1720dc4b2f2da387c90c46017fcf3d8e87287c64191e2f6e904bb1b0e; \
    wget -q "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64" -O /usr/local/bin/docker-compose; \
    echo "${COMPOSE_SHA256}  /usr/local/bin/docker-compose" | sha256sum -c -; \
    chmod +x /usr/local/bin/docker-compose

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
