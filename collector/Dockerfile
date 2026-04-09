# Build stage
FROM rust:1.75-alpine

# Use Chinese Rust cargo mirror
ENV CARGO_REGISTRIES_CRATES_IO_PROTOCOL=sparse
RUN echo '[source.crates-io] \
replace-with = "ustc" \
[source.ustc] \
registry = "sparse+https://mirrors.ustc.edu.cn/crates.io-index/"' \
    > /root/.cargo/config.toml

# Install build dependencies
RUN apk add --no-cache clang llvm lld elfutils-dev libelf-dev libbpf-dev linux-headers openssl-dev

WORKDIR /app

# Copy Cargo files first for better caching
COPY Cargo.toml Cargo.lock ./

# Create dummy source and pre-build dependencies
RUN mkdir src && echo "fn main() {}" > src/main.rs && \
    cargo build --release 2>/dev/null || true && \
    rm -rf src

# Copy source code
COPY . .

# Build the userspace uprobe BPF object. The collector still falls back to WAL
# file polling at runtime if the kernel or container permissions reject eBPF.
RUN ./build-ebpf.sh

# Build
RUN cargo build --release

# Production stage
FROM alpine:3.19

RUN apk add --no-cache libelf

WORKDIR /app

COPY --from=0 /app/target/release/pg-collector /app/collector
COPY --from=0 /app/probes/probe.bpf.o /app/probes/probe.bpf.o

CMD ["/app/collector"]
