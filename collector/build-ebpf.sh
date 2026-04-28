#!/usr/bin/env sh
set -eu

BPF_INCLUDE="${BPF_INCLUDE:-/work/ai/learn_pg/collector/include}"

ARCH="${BPF_TARGET_ARCH:-$(uname -m)}"
case "$ARCH" in
  x86_64|amd64)  TARGET_ARCH="x86" ;;
  aarch64|arm64) TARGET_ARCH="arm64" ;;
  *)             echo "Unsupported BPF_TARGET_ARCH: $ARCH" >&2; exit 1 ;;
esac

SYSROOT="$(uname -r)"

BPF_HEADERS=""
for dir in \
    "${BPF_INCLUDE}" \
    "/dev_tool/go_cache/github.com/cilium/ebpf@v0.20.0/examples/headers" \
    "/dev_tool/go_cache/github.com/cilium/ebpf@v0.11.0/examples/headers" \
    "${HOME}/go_cache/github.com/cilium/ebpf@v0.20.0/examples/headers" \
; do
  if [ -f "${dir}/bpf_helpers.h" ]; then
    BPF_HEADERS="$dir"
    break
  fi
done

if [ -z "$BPF_HEADERS" ]; then
  echo "ERROR: bpf_helpers.h not found in any known location." >&2
  exit 1
fi

# Kernel headers: linux/bpf.h for BPF_MAP_TYPE_*, linux/bpf_common.h for BPF_ANY
# Use /usr/include which contains headers from linux-libc-dev (always installed)
KERNEL_HEADERS="/usr/include"

# Symlink cilium headers into include/bpf/ so #include <bpf/bpf_helpers.h> resolves
mkdir -p "${BPF_INCLUDE}/bpf"
for f in "${BPF_HEADERS}"/*.h; do
  ln -sf "$f" "${BPF_INCLUDE}/bpf/" 2>/dev/null || true
done

OUT="${BPF_OBJECT_PATH:-probes/probe.bpf.o}"
mkdir -p "$(dirname "$OUT")"

echo "[bpf] cilium headers : ${BPF_HEADERS}"
echo "[bpf] kernel headers : ${KERNEL_HEADERS}"
clang \
  -target bpf \
  -D__TARGET_ARCH_${TARGET_ARCH} \
  -I"${BPF_INCLUDE}" \
  -I"${KERNEL_HEADERS}" \
  -O2 \
  -g \
  -Wall \
  -Werror \
  -c probes/probe.bpf.c \
  -o "$OUT"

echo "Built $OUT"
