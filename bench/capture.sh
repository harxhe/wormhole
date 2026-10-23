#!/usr/bin/env sh
# Capture Wormhole traffic on Linux/macOS.
# Usage: sudo ./bench/capture.sh [seconds] [interface] [output]
set -eu

SECONDS_TO_CAPTURE="${1:-20}"
IFACE="${2:-lo}"
OUT="${3:-bench/results/wormhole.pcap}"
FILTER="tcp port 4443 or tcp port 8080 or (tcp portrange 15000-15099)"

mkdir -p "$(dirname "$OUT")"

if command -v tcpdump >/dev/null 2>&1; then
  echo "capturing ${SECONDS_TO_CAPTURE}s on ${IFACE} -> ${OUT}"
  # -G/-W would split files; timeout keeps one capture file.
  timeout "$SECONDS_TO_CAPTURE" tcpdump -i "$IFACE" -w "$OUT" "$FILTER" || true
elif command -v tshark >/dev/null 2>&1; then
  echo "capturing ${SECONDS_TO_CAPTURE}s on ${IFACE} -> ${OUT}"
  tshark -i "$IFACE" -a "duration:${SECONDS_TO_CAPTURE}" -f "$FILTER" -w "$OUT"
else
  echo "tcpdump or tshark is required" >&2
  exit 1
fi

echo "done: ${OUT}"
