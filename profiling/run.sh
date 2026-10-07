#!/usr/bin/env bash
# Profiles the API's CPU use end to end, unattended: builds the API, starts a
# fresh copy of it under node's CPU profiler (--cpu-prof), drives a fixed
# amount of work through it with profile.k6.js, stops the API so the profile
# is written, then summarises the profile. Everything is written to one
# directory, and its path is the last line printed.
#
# Usage:
#   profiling/run.sh [label] [-- extra k6 args...]
# e.g.
#   profiling/run.sh
#   profiling/run.sh after-list-fix -- -e ITERATIONS=50000
#
# The API runs on its own port (PORT, default 3100), so a dev server on 3000
# is never touched, and the run refuses to start if that port is in use. The
# API and k6 are pinned to separate cores so k6 doesn't take CPU from the API.
#
# Output goes to profiling/reports/<date>-<time>[-label]/:
#   summary.md         the profile summarised: where CPU time went, by area,
#                      package, file and function; read this first
#   summary.json       the same, machine-readable
#   run.json           what ran, how, and the outcome
#   api.cpuprofile     the raw V8 CPU profile (open in Chrome DevTools'
#                      Performance panel, or https://www.speedscope.app)
#   k6-summary.json    k6's end-of-test summary (legacy format)
#   k6-console.txt     k6's console output
#   api.log, build.log the API's and the build's output
#
# The profile covers the API's whole life, so it includes startup and the
# idle time before and after the load. summary.md reports idle time
# separately and gives percentages of busy time, but startup work (module
# loading, building the OpenAPI spec) still counts; use enough iterations
# that it is a small share.
#
# Exits 0 if the profile was captured and summarised, 1 if k6 reported an
# error or failed requests (the profile is still summarised if there is
# one), 2 if the run couldn't be set up or no profile was written.
#
# Env vars:
#   PORT               port the API listens on            (default 3100)
#   API_CPUS           cores for the API (taskset)        (default 0,1)
#   K6_CPUS            cores for k6 (taskset)             (default 2,3)
#   SAMPLE_INTERVAL_US profiler sampling interval, in µs  (default 1000)
#   SKIP_BUILD         set to 1 to reuse dist/            (default: build)
set -euo pipefail

usage() {
  echo "Usage: profiling/run.sh [label] [-- extra k6 args...]" >&2
  exit 2
}

label=""
if [[ $# -gt 0 && "$1" != "--" ]]; then
  label="$1"
  shift
fi
[[ $# -gt 0 && "$1" != "--" ]] && usage
[[ $# -gt 0 ]] && shift
k6_args=("$@")

PORT="${PORT:-3100}"
API_CPUS="${API_CPUS:-0,1}"
K6_CPUS="${K6_CPUS:-2,3}"
SAMPLE_INTERVAL_US="${SAMPLE_INTERVAL_US:-1000}"

profiling_dir="$(cd "$(dirname "$0")" && pwd)"
cd "$profiling_dir/.."

out_dir="$profiling_dir/reports/$(date +%Y%m%d-%H%M%S)${label:+-$label}"
mkdir -p "$out_dir"

log() { echo "[profile] $*"; }
setup_failed() {
  echo "[profile] $*" >&2
  exit 2
}

if [[ -n "$(ss -ltnH "sport = :$PORT")" ]]; then
  setup_failed "Port $PORT is already in use. Stop whatever is on it, or set PORT."
fi

api_pid=""
cleanup() {
  if [[ -n "$api_pid" ]] && kill -0 "$api_pid" 2>/dev/null; then
    kill -KILL "$api_pid"
  fi
  rm -rf "$out_dir/.cpuprofile"
}
trap cleanup EXIT

if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  log "Building..."
  pnpm build > "$out_dir/build.log" 2>&1 || setup_failed "Build failed, see $out_dir/build.log"
fi

log "Starting API under the CPU profiler on port $PORT (cores $API_CPUS)..."
PORT="$PORT" taskset -c "$API_CPUS" node \
  --cpu-prof --cpu-prof-dir="$out_dir/.cpuprofile" --cpu-prof-interval="$SAMPLE_INTERVAL_US" \
  dist/server.js > "$out_dir/api.log" 2>&1 &
api_pid=$!
base_url="http://localhost:$PORT"
for _ in $(seq 1 50); do
  curl -sf "$base_url/health" > /dev/null && break
  kill -0 "$api_pid" 2>/dev/null || setup_failed "API exited on startup, see $out_dir/api.log"
  sleep 0.2
done
curl -sf "$base_url/health" > /dev/null || setup_failed "API not healthy after 10s, see $out_dir/api.log"

log "Running profile.k6.js (cores $K6_CPUS)..."
started_at="$(date -Iseconds)"
k6_exit=0
taskset -c "$K6_CPUS" k6 run --quiet --no-color \
  --summary-export "$out_dir/k6-summary.json" \
  -e BASE_URL="$base_url" "${k6_args[@]}" "$profiling_dir/profile.k6.js" \
  > "$out_dir/k6-console.txt" 2>&1 || k6_exit=$?
finished_at="$(date -Iseconds)"

# The profile is only written when the API exits normally, which it does on
# SIGTERM (see src/server.ts).
log "Stopping API so the profile is written..."
api_alive_at_end=false
if kill -0 "$api_pid" 2>/dev/null; then
  api_alive_at_end=true
  kill -TERM "$api_pid"
  for _ in $(seq 1 100); do
    kill -0 "$api_pid" 2>/dev/null || break
    sleep 0.1
  done
  kill -0 "$api_pid" 2>/dev/null && setup_failed "API didn't exit within 10s of SIGTERM, so no profile was written"
fi
api_exit=0
wait "$api_pid" || api_exit=$?
api_pid=""

profiles=("$out_dir"/.cpuprofile/*.cpuprofile)
[[ -f "${profiles[0]}" ]] || setup_failed "No CPU profile was written (API exit code $api_exit), see $out_dir/api.log"
mv "${profiles[0]}" "$out_dir/api.cpuprofile"

# Written with node so values are JSON-escaped properly.
RUN_JSON_OUT="$out_dir/run.json" node -e '
const fs = require("node:fs");
const [label, port, apiCpus, k6Cpus, sampleIntervalUs, startedAt, finishedAt, k6Exit, apiAliveAtEnd, apiExit, commit, dirty, ...k6Args] =
  process.argv.slice(1);
fs.writeFileSync(process.env.RUN_JSON_OUT, JSON.stringify({
  label: label || null, k6_args: k6Args,
  base_url: `http://localhost:${port}`, api_cpus: apiCpus, k6_cpus: k6Cpus,
  sample_interval_us: Number(sampleIntervalUs),
  started_at: startedAt, finished_at: finishedAt,
  k6_exit_code: Number(k6Exit),
  api_alive_at_end: apiAliveAtEnd === "true", api_exit_code: Number(apiExit),
  git: { commit, dirty: dirty === "true" },
}, null, 2) + "\n");
' "$label" "$PORT" "$API_CPUS" "$K6_CPUS" "$SAMPLE_INTERVAL_US" "$started_at" "$finished_at" "$k6_exit" \
  "$api_alive_at_end" "$api_exit" "$(git rev-parse --short HEAD)" "$([[ -n "$(git status --porcelain)" ]] && echo true || echo false)" \
  "${k6_args[@]}"

log "Summarising profile..."
node "$profiling_dir/scripts/summarise.mjs" "$out_dir" \
  || setup_failed "Couldn't summarise the profile, see the error above; the raw profile is $out_dir/api.cpuprofile"

exit_code=0
if [[ "$k6_exit" -ne 0 ]]; then
  log "k6 exited $k6_exit, see $out_dir/k6-console.txt"
  exit_code=1
fi
failed_requests="$(node -e '
const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
console.log(s.metrics.http_req_failed?.passes ?? 0);' "$out_dir/k6-summary.json" 2>/dev/null || echo unknown)"
if [[ "$failed_requests" != "0" ]]; then
  log "Failed requests: $failed_requests, so the profile may not show normal behaviour"
  exit_code=1
fi
log "Output in:"
echo "$out_dir"
exit "$exit_code"
