# Build stage
FROM docker.m.daocloud.io/library/golang:1.21-alpine AS builder

# Use Chinese Go proxy
ENV GOPROXY=https://goproxy.cn,direct
ENV GO111MODULE=on
ENV GOSUMDB=off

RUN apk add --no-cache ca-certificates git

WORKDIR /app

# Copy go mod files first for better caching
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o server ./cmd/server

# Production stage
FROM docker.m.daocloud.io/library/alpine:latest

RUN apk add --no-cache ca-certificates wget docker-cli && \
    wget -q https://github.com/docker/compose/releases/download/v2.24.0/docker-compose-linux-x86_64 -O /usr/local/bin/docker-compose && \
    chmod +x /usr/local/bin/docker-compose

WORKDIR /app

COPY --from=builder /app/server .

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
    CMD wget -qO- http://localhost:3000/health || exit 1

ENTRYPOINT ["/app/server"]