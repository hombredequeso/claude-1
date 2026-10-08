#!/usr/bin/env bash
# Records CPU and memory for the API and k6 while a k6 test runs, so results
# can be checked afterwards for whether the API or k6 was the limit.
#
# Usage: start the API, start this script, then start k6 in another terminal:
#   load-tests/monitor.sh [label]
#
# It waits for k6 to start, records once a second until k6 exits, then stops.
# Output goes to load-tests/reports/<date>-<time>[-label]/:
#   run.txt              API and k6 pids, k6 command line, start and end times
#   pidstat.log          per process: CPU (user/system), memory, context switches
#   pidstat-threads.log  per API thread: the main JavaScript thread is the one
#                        whose TID equals the API's pid; ~100% there means the
#                        API is saturated, whatever the process total says
#   vmstat.log           whole machine: run queue (r), idle CPU (id), swapping
#
# Env vars (load-tests/run.sh sets all three):
#   API_PID  pid of the API process (default: the node process running the
#            manifest's start.entry, see .claude/diagnostics.json)
#   K6_PID   pid of the k6 process to record (default: wait for k6 to start)
#   OUT_DIR  output directory (default: a new directory under load-tests/reports/)
set -euo pipefail

reports_dir="$(cd "$(dirname "$0")" && pwd)/reports"
out_dir="${OUT_DIR:-$reports_dir/$(date +%Y%m%d-%H%M%S)${1:+-$1}}"

api_pid="${API_PID:-}"
if [[ -z "$api_pid" ]]; then
  log() { echo "$*"; }
  setup_failed() {
    echo "$*" >&2
    exit 1
  }
  cd "$reports_dir/../.."
  source scripts/diagnostics-app.sh
  diag_load_manifest
  api_pid="$(pgrep -f "^node .*$DIAG_ENTRY" || true)"
  if [[ -z "$api_pid" || "$api_pid" == *$'\n'* ]]; then
    echo "Expected exactly one API process running 'node ... $DIAG_ENTRY', found: ${api_pid:-none}." >&2
    echo "Start the API, or set API_PID." >&2
    exit 1
  fi
fi

k6_pid="${K6_PID:-}"
if [[ -z "$k6_pid" ]]; then
  echo "API pid $api_pid. Waiting for k6 to start..."
  until k6_pid="$(pgrep -n -x k6)"; do
    sleep 0.2
  done
fi

mkdir -p "$out_dir"
{
  echo "api_pid: $api_pid"
  echo "api_command: $(ps -o args= -p "$api_pid")"
  echo "k6_pid: $k6_pid"
  echo "k6_command: $(ps -o args= -p "$k6_pid")"
  echo "start: $(date '+%F %T')"
} > "$out_dir/run.txt"

pidstat -h -u -r -w -p "$api_pid,$k6_pid" 1 > "$out_dir/pidstat.log" &
pidstat -h -t -u -p "$api_pid" 1 > "$out_dir/pidstat-threads.log" &
vmstat -t -w 1 > "$out_dir/vmstat.log" &

stop_recording() {
  kill $(jobs -p) 2>/dev/null || true
  echo "end: $(date '+%F %T')" >> "$out_dir/run.txt"
  echo "Recording stopped. Output in $out_dir"
}
trap stop_recording EXIT

echo "k6 pid $k6_pid. Recording to $out_dir (Ctrl-C to stop early)..."
while kill -0 "$k6_pid" 2>/dev/null; do
  sleep 1
done
