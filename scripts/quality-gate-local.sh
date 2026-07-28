#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="${CONTAINER_NAME:-claude-code-chat-explorer}"
PORT="${PORT:-9876}"
BENCH_FILE="${BENCH_FILE:-$HOME/.claude/projects/codex_quality_gate/conversation.jsonl}"
SAMPLES="${SAMPLES:-60}"
SAMPLE_INTERVAL="${SAMPLE_INTERVAL:-1}"
BURST_LINES="${BURST_LINES:-220}"
BURST_DELAY="${BURST_DELAY:-0.02}"
MAX_AVG_CPU="${MAX_AVG_CPU:-8}"
MAX_P95_CPU="${MAX_P95_CPU:-40}"
MAX_MAX_CPU="${MAX_MAX_CPU:-80}"
MAX_WATCHER_ERRORS="${MAX_WATCHER_ERRORS:-0}"

OUT_DIR="${OUT_DIR:-/tmp/quality-gate-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT_DIR"

log() { echo "[$(date +%H:%M:%S)] $*"; }

json_int() {
  local file="$1"
  local key="$2"
  tr -d '\n' < "$file" | sed -n "s/.*\"${key}\":[[:space:]]*\\([0-9]\\+\\).*/\\1/p" | head -n1
}

calc_cpu_stats() {
  local input="$1"
  local sorted="$OUT_DIR/cpu-sorted.txt"

  awk -F'|' '{gsub(/%/, "", $2); print $2+0}' "$input" > "$OUT_DIR/cpu-values.txt"
  sort -n "$OUT_DIR/cpu-values.txt" > "$sorted"

  local n avg max i95 p95
  n="$(wc -l < "$OUT_DIR/cpu-values.txt" | tr -d ' ')"
  avg="$(awk '{sum+=$1} END {if (NR==0) print 0; else printf "%.2f", sum/NR}' "$OUT_DIR/cpu-values.txt")"
  max="$(awk 'BEGIN{m=0} {if ($1>m) m=$1} END {printf "%.2f", m}' "$OUT_DIR/cpu-values.txt")"
  i95=$(( (95*n + 99) / 100 ))
  p95="$(sed -n "${i95}p" "$sorted")"
  p95="${p95:-0}"

  echo "$n|$avg|$p95|$max"
}

mkdir -p "$(dirname "$BENCH_FILE")"
: > "$BENCH_FILE"

# The bench file is a synthetic transcript inside the real corpus; without
# cleanup it shows up in the UI as a project full of "quality gate payload"
# messages. Remove it (and its directory, if the gate owns it) on every exit
# so the watcher drops the conversation again.
cleanup_bench() {
  rm -f "$BENCH_FILE"
  rmdir "$(dirname "$BENCH_FILE")" 2>/dev/null || true
}
trap cleanup_bench EXIT

log "Building and starting container"
docker compose up -d --build chat-explorer >/dev/null
sleep 6

START_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "Capturing $SAMPLES docker stats samples into $OUT_DIR/stats.txt"
(
  for _ in $(seq 1 "$SAMPLES"); do
    ts="$(date +%s)"
    docker stats --no-stream --format '{{.CPUPerc}}|{{.MemUsage}}' "$CONTAINER_NAME" | sed "s/^/$ts|/"
    sleep "$SAMPLE_INTERVAL"
  done
) > "$OUT_DIR/stats.txt" &
STATS_PID=$!

log "Applying write burst ($BURST_LINES lines, delay $BURST_DELAY s)"
for i in $(seq 1 "$BURST_LINES"); do
  printf '{"type":"assistant","timestamp":"%s","message":{"id":"gate-%s","role":"assistant","content":"quality gate payload %s"}}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" "$i" "$i" >> "$BENCH_FILE"
  sleep "$BURST_DELAY"
done

wait "$STATS_PID"
docker logs --since "$START_TS" "$CONTAINER_NAME" > "$OUT_DIR/container.log" 2>&1 || true
curl -sf "http://127.0.0.1:${PORT}/api/system/metrics" > "$OUT_DIR/metrics.json"

IFS='|' read -r samples avg_cpu p95_cpu max_cpu <<< "$(calc_cpu_stats "$OUT_DIR/stats.txt")"
watcher_errors="$(json_int "$OUT_DIR/metrics.json" "watcherErrors")"
watcher_errors="${watcher_errors:-0}"
refresh_attempts="$(json_int "$OUT_DIR/metrics.json" "dataRefreshAttempts")"
refresh_attempts="${refresh_attempts:-0}"

refresh_log_count="$(rg -c "Data refreshed from file changes" "$OUT_DIR/container.log" || true)"
watcher_error_log_count="$(rg -c "File watcher error|EINVAL|Unhandled 'error' event" "$OUT_DIR/container.log" || true)"
refresh_log_count="${refresh_log_count:-0}"
watcher_error_log_count="${watcher_error_log_count:-0}"

echo "quality_gate_output_dir=$OUT_DIR"
echo "cpu_samples=$samples"
echo "cpu_avg_percent=$avg_cpu"
echo "cpu_p95_percent=$p95_cpu"
echo "cpu_max_percent=$max_cpu"
echo "watcher_errors_total=$watcher_errors"
echo "data_refresh_attempts_total=$refresh_attempts"
echo "refresh_log_lines=$refresh_log_count"
echo "watcher_error_log_lines=$watcher_error_log_count"

fail=0
if awk "BEGIN { exit !($avg_cpu > $MAX_AVG_CPU) }"; then
  log "FAIL: avg CPU $avg_cpu > threshold $MAX_AVG_CPU"
  fail=1
fi
if awk "BEGIN { exit !($p95_cpu > $MAX_P95_CPU) }"; then
  log "FAIL: p95 CPU $p95_cpu > threshold $MAX_P95_CPU"
  fail=1
fi
if awk "BEGIN { exit !($max_cpu > $MAX_MAX_CPU) }"; then
  log "FAIL: max CPU $max_cpu > threshold $MAX_MAX_CPU"
  fail=1
fi
if [ "$watcher_errors" -gt "$MAX_WATCHER_ERRORS" ]; then
  log "FAIL: watcher errors $watcher_errors > threshold $MAX_WATCHER_ERRORS"
  fail=1
fi
if [ "$watcher_error_log_count" -gt 0 ]; then
  log "FAIL: watcher/runtime error patterns detected in logs"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  log "PASS: quality gate satisfied"
  exit 0
fi

log "FAIL: quality gate did not pass"
exit 1
