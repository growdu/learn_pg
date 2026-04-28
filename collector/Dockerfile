# Production-only: copies pre-built binary + BPF object from build context.
FROM docker.m.daocloud.io/library/debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libelf1 libssl3 ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Binary and BPF object are in the build context
COPY target/release/pg-collector ./pg-collector
COPY probes/ ./probes/
COPY *.sh ./ 2>/dev/null || true

ENTRYPOINT ["/app/pg-collector"]
