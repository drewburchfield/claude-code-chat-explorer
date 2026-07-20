#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="${CONTAINER_NAME:-claude-code-chat-explorer}"
PORT="${PORT:-9876}"
DURATION_SECONDS="${DURATION_SECONDS:-600}"
INTERVAL_SECONDS="${INTERVAL_SECONDS:-5}"
MAX_AVG_CPU="${MAX_AVG_CPU:-10}"
MAX_MAX_CPU="${MAX_MAX_CPU:-60}"
MAX_WATCHER_ERRORS_DELTA="${MAX_WATCHER_ERRORS_DELTA:-0}"
CHAT_EXPLORER_AUTH_TOKEN="${CHAT_EXPLORER_AUTH_TOKEN:-}"

if [ -z "$CHAT_EXPLORER_AUTH_TOKEN" ]; then
  echo "CHAT_EXPLORER_AUTH_TOKEN must be set so the monitor can read protected metrics" >&2
  exit 1
fi

OUT_DIR="${OUT_DIR:-/tmp/runtime-monitor-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT_DIR"

log() { echo "[$(date +%H:%M:%S)] $*"; }

json_int() {
  local file="$1"
  local key="$2"
  tr -d '\n' < "$file" | sed -n "s/.*\"${key}\":[[:space:]]*\\([0-9]\\+\\).*/\\1/p" | head -n1
}

START_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
END_EPOCH=$(( $(date +%s) + DURATION_SECONDS ))

log "Monitoring for ${DURATION_SECONDS}s at ${INTERVAL_SECONDS}s intervals"

curl -sf -H "Authorization: Bearer ${CHAT_EXPLORER_AUTH_TOKEN}" \
  "http://127.0.0.1:${PORT}/api/system/metrics" > "$OUT_DIR/metrics-start.json"
START_WATCHER_ERRORS="$(json_int "$OUT_DIR/metrics-start.json" "watcherErrors")"
START_WATCHER_ERRORS="${START_WATCHER_ERRORS:-0}"

while [ "$(date +%s)" -lt "$END_EPOCH" ]; do
  ts="$(date +%s)"
  docker stats --no-stream --format '{{.CPUPerc}}|{{.MemUsage}}' "$CONTAINER_NAME" | sed "s/^/$ts|/" >> "$OUT_DIR/stats.txt"
  curl -sf -H "Authorization: Bearer ${CHAT_EXPLORER_AUTH_TOKEN}" \
    "http://127.0.0.1:${PORT}/api/system/metrics" > "$OUT_DIR/metrics-current.json"
  sleep "$INTERVAL_SECONDS"
done

docker logs --since "$START_TS" "$CONTAINER_NAME" > "$OUT_DIR/container.log" 2>&1 || true

avg_cpu="$(awk -F'|' '{gsub(/%/, "", $2); sum+=$2; n++} END {if (n==0) print 0; else printf "%.2f", sum/n}' "$OUT_DIR/stats.txt")"
max_cpu="$(awk -F'|' 'BEGIN {m=0} {gsub(/%/, "", $2); if (($2+0)>m) m=$2+0} END {printf "%.2f", m}' "$OUT_DIR/stats.txt")"

END_WATCHER_ERRORS="$(json_int "$OUT_DIR/metrics-current.json" "watcherErrors")"
END_WATCHER_ERRORS="${END_WATCHER_ERRORS:-0}"
WATCHER_ERRORS_DELTA=$(( END_WATCHER_ERRORS - START_WATCHER_ERRORS ))

error_lines="$(rg -c "File watcher error|EINVAL|Unhandled 'error' event|throw er; // Unhandled" "$OUT_DIR/container.log" || true)"
error_lines="${error_lines:-0}"

echo "runtime_monitor_output_dir=$OUT_DIR"
echo "cpu_avg_percent=$avg_cpu"
echo "cpu_max_percent=$max_cpu"
echo "watcher_errors_start=$START_WATCHER_ERRORS"
echo "watcher_errors_end=$END_WATCHER_ERRORS"
echo "watcher_errors_delta=$WATCHER_ERRORS_DELTA"
echo "fatal_error_log_lines=$error_lines"

fail=0
if awk "BEGIN { exit !($avg_cpu > $MAX_AVG_CPU) }"; then
  log "FAIL: avg CPU $avg_cpu > threshold $MAX_AVG_CPU"
  fail=1
fi
if awk "BEGIN { exit !($max_cpu > $MAX_MAX_CPU) }"; then
  log "FAIL: max CPU $max_cpu > threshold $MAX_MAX_CPU"
  fail=1
fi
if [ "$WATCHER_ERRORS_DELTA" -gt "$MAX_WATCHER_ERRORS_DELTA" ]; then
  log "FAIL: watcher error delta $WATCHER_ERRORS_DELTA > threshold $MAX_WATCHER_ERRORS_DELTA"
  fail=1
fi
if [ "$error_lines" -gt 0 ]; then
  log "FAIL: fatal watcher/runtime patterns found in logs"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  log "PASS: runtime monitor checks satisfied"
  exit 0
fi

log "FAIL: runtime monitor detected issues"
exit 1
