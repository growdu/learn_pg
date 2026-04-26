# Build stage
FROM docker.m.daocloud.io/library/debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    clang llvm lld libelf-dev libbpf-dev linux-libc-dev libc6-dev \
    libssl-dev pkg-config wget ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Install Rust
RUN wget -qO- https://sh.rustup.rs | sh /dev/stdin -y --default-toolchain 1.75.0
ENV PATH="/root/.cargo/bin:${PATH}"
ENV CARGO_REGISTRIES_CRATES_IO_PROTOCOL=sparse
RUN echo '[source.crates-io]' \
    'replace-with = "ustc"' \
    '[source.ustc]' \
    'registry = "sparse+https://mirrors.ustc.edu.cn/crates.io-index/"' \
    > /root/.cargo/config.toml

# Download cilium/ebpf headers for BPF compilation
RUN mkdir -p /app/collector/include && \
    for f in bpf_helpers.h bpf_tracing.h bpf_endian.h bpf_hints.h; do \
      wget -q "https://raw.githubusercontent.com/cilium/ebpf/main/examples/headers/${f}" \
        -O "/app/collector/include/${f}" 2>/dev/null || true; \
    done

WORKDIR /app

# Copy Cargo files first for better caching
COPY collector/Cargo.toml collector/Cargo.lock ./

# Create dummy source and pre-build dependencies
RUN mkdir src && printf 'fn main() {}\n' > src/main.rs && \
    cargo build --release 2>/dev/null || true && \
    rm -rf src

# Copy source code
COPY collector/ .

# Build the userspace uprobe BPF object. The collector still falls back to WAL
# file polling at runtime if the kernel or container permissions reject eBPF.
RUN ./build-ebpf.sh

# Build
RUN cargo build --release

# Production stage
FROM docker.m.daocloud.io/library/debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libelf1 libssl3 ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=0 /app/target/release/pg-collector /app/collector
COPY --from=0 /app/probes/probe.bpf.o /app/probes/probe.bpf.o

CMD ["/app/collector"]
