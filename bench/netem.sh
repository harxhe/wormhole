#!/usr/bin/env sh
# Add or remove delay/loss on a network interface for benchmark runs.
# Usage:
#   sudo ./bench/netem.sh add [delay_ms] [loss_percent] [interface]
#   sudo ./bench/netem.sh del [interface]
set -eu

ACTION="${1:-add}"
DELAY="${2:-50}"
LOSS="${3:-1}"
DEV="${4:-lo}"

if [ "$ACTION" = "add" ]; then
  tc qdisc replace dev "$DEV" root netem delay "${DELAY}ms" loss "${LOSS}%"
  echo "netem on $DEV: ${DELAY}ms delay, ${LOSS}% loss"
elif [ "$ACTION" = "del" ]; then
  tc qdisc del dev "$DEV" root 2>/dev/null || true
  echo "netem cleared on $DEV"
else
  echo "usage: $0 {add|del} [delay_ms] [loss_percent] [interface]" >&2
  exit 1
fi
