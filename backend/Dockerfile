FROM golang:1.21-alpine

RUN apk add --no-cache ca-certificates

WORKDIR /app

COPY server .

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
    CMD wget -qO- http://localhost:3000/health || exit 1

ENTRYPOINT ["/app/server"]