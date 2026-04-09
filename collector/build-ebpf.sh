#!/usr/bin/env sh
set -eu

ARCH="${BPF_TARGET_ARCH:-$(uname -m)}"
case "$ARCH" in
  x86_64|amd64)
    TARGET_ARCH="x86"
    ;;
  aarch64|arm64)
    TARGET_ARCH="arm64"
    ;;
  *)
    echo "Unsupported BPF_TARGET_ARCH: $ARCH" >&2
    exit 1
    ;;
esac

OUT="${BPF_OBJECT_PATH:-probes/probe.bpf.o}"
mkdir -p "$(dirname "$OUT")"

clang \
  -target bpf \
  -D__TARGET_ARCH_${TARGET_ARCH} \
  -O2 \
  -g \
  -Wall \
  -Werror \
  -c probes/probe.bpf.c \
  -o "$OUT"

echo "Built $OUT"
