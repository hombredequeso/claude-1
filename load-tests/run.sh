#!/usr/bin/env bash
# Runs a k6 test end to end, unattended: builds the API, starts a fresh copy
# of it, records CPU and memory with monitor.sh while k6 runs, then stops the
# API. Everything a later assessment needs is written to one directory.
#
# Usage:
#   load-tests/run.sh <k6-script> [label] [-- extra k6 args...]
# e.g.
#   load-tests/run.sh load-tests/breaking-point.k6.js
#   load-tests/run.sh load-tests/breaking-point.k6.js pre-vus-1000 -- -e PRE_VUS=1000
#
# The API runs on its own port (PORT, default 3100), so a dev server on 3000
# is never touched, and the run refuses to start if that port is in use. The
# API and k6 are pinned to separate cores so neither starves the other.
#
# Output goes to load-tests/reports/<date>-<time>-<script>[-label]/:
#   run.json             what ran, how, the outcome, the thresholds crossed,
#                        and for breaking-point.k6.js each step's result and a
#                        verdict (see scripts/run-result.mjs), and the files below
#   k6-console.txt       k6's console output, including the end-of-test summary
#   summary.json         the end-of-test summary, machine-readable (k6's legacy
#                        format, the one that records threshold results)
#   dashboard.html       the k6 web dashboard report (open in a browser)
#   timeseries.csv       the dashboard's 10s time series, extracted to CSV
#   pidstat.log, pidstat-threads.log, vmstat.log, run.txt   see monitor.sh
#   api.log, build.log   the API's and the build's output
#
# Exits with k6's exit code: 0 all thresholds passed, 99 a threshold was
# crossed (expected for breaking-point.k6.js), anything else an error. Exits
# 2 if the run couldn't be set up. run.json records the same outcome; for
# breaking-point.k6.js, its breaking_point.verdict says whether 99 meant the
# API broke or only that k6 couldn't keep up.
#
# Env vars:
#   PORT        port the API listens on      (default 3100)
#   API_CPUS    cores for the API (taskset)  (default 0,1)
#   K6_CPUS     cores for k6 (taskset)       (default 2,3)
#   SKIP_BUILD  set to 1 to reuse dist/      (default: build)
set -euo pipefail

usage() {
  echo "Usage: load-tests/run.sh <k6-script> [label] [-- extra k6 args...]" >&2
  exit 2
}

[[ $# -ge 1 && -f "$1" ]] || usage
script="$(realpath "$1")"
shift
label=""
if [[ $# -gt 0 && "$1" != "--" ]]; then
  label="$1"
  shift
fi
[[ $# -gt 0 && "$1" == "--" ]] && shift
k6_args=("$@")

PORT="${PORT:-3100}"
API_CPUS="${API_CPUS:-0,1}"
K6_CPUS="${K6_CPUS:-2,3}"

load_tests_dir="$(cd "$(dirname "$0")" && pwd)"
cd "$load_tests_dir/.."

script_name="$(basename "$script" .js)"
script_name="${script_name%.k6}"
out_dir="$load_tests_dir/reports/$(date +%Y%m%d-%H%M%S)-$script_name${label:+-$label}"
mkdir -p "$out_dir"

log() { echo "[run.sh] $*"; }
setup_failed() {
  echo "[run.sh] $*" >&2
  exit 2
}

if [[ -n "$(ss -ltnH "sport = :$PORT")" ]]; then
  setup_failed "Port $PORT is already in use. Stop whatever is on it, or set PORT."
fi

api_pid=""
monitor_pid=""
cleanup() {
  [[ -n "$monitor_pid" ]] && kill "$monitor_pid" 2>/dev/null || true
  if [[ -n "$api_pid" ]] && kill -0 "$api_pid" 2>/dev/null; then
    kill "$api_pid"
    wait "$api_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  log "Building..."
  pnpm build > "$out_dir/build.log" 2>&1 || setup_failed "Build failed, see $out_dir/build.log"
fi

log "Starting API on port $PORT (cores $API_CPUS)..."
PORT="$PORT" taskset -c "$API_CPUS" node dist/server.js > "$out_dir/api.log" 2>&1 &
api_pid=$!
base_url="http://localhost:$PORT"
for _ in $(seq 1 50); do
  curl -sf "$base_url/health" > /dev/null && break
  kill -0 "$api_pid" 2>/dev/null || setup_failed "API exited on startup, see $out_dir/api.log"
  sleep 0.2
done
curl -sf "$base_url/health" > /dev/null || setup_failed "API not healthy after 10s, see $out_dir/api.log"

log "Running $script (cores $K6_CPUS), output in $out_dir ..."
started_at="$(date -Iseconds)"
K6_WEB_DASHBOARD=true \
  K6_WEB_DASHBOARD_PORT=-1 \
  K6_WEB_DASHBOARD_EXPORT="$out_dir/dashboard.html" \
  taskset -c "$K6_CPUS" k6 run --quiet --no-color \
  --summary-export "$out_dir/summary.json" \
  -e BASE_URL="$base_url" "${k6_args[@]}" "$script" \
  > "$out_dir/k6-console.txt" 2>&1 &
k6_pid=$!

API_PID="$api_pid" K6_PID="$k6_pid" OUT_DIR="$out_dir" "$load_tests_dir/monitor.sh" > /dev/null &
monitor_pid=$!

k6_exit=0
wait "$k6_pid" || k6_exit=$?
finished_at="$(date -Iseconds)"
wait "$monitor_pid" || true
monitor_pid=""

api_alive=false
kill -0 "$api_pid" 2>/dev/null && api_alive=true

timeseries_exit=0
if [[ -f "$out_dir/dashboard.html" ]]; then
  node "$load_tests_dir/scripts/dashboard-timeseries.mjs" "$out_dir/dashboard.html" \
    > "$out_dir/timeseries.csv" 2> "$out_dir/timeseries.err" || timeseries_exit=$?
  [[ -s "$out_dir/timeseries.err" ]] || rm "$out_dir/timeseries.err"
fi

result_json="$out_dir/.result.json"
echo '{}' > "$result_json"
if [[ -f "$out_dir/summary.json" ]]; then
  node "$load_tests_dir/scripts/run-result.mjs" "$out_dir" "$(taskset -c "$K6_CPUS" nproc)" > "$result_json" \
    || { log "Couldn't read summary.json for run.json's result"; echo '{}' > "$result_json"; }
fi

case "$k6_exit" in
  0) outcome="thresholds_passed" ;;
  99) outcome="thresholds_crossed" ;;
  *) outcome="k6_error" ;;
esac

# Written with node so values are JSON-escaped properly.
RUN_JSON_OUT="$out_dir/run.json" RESULT_JSON="$result_json" node -e '
const fs = require("node:fs");
const result = JSON.parse(fs.readFileSync(process.env.RESULT_JSON, "utf8"));
const [script, label, port, apiCpus, k6Cpus, startedAt, finishedAt, k6Exit, outcome, apiAlive, commit, dirty, outDir, ...k6Args] =
  process.argv.slice(1);
fs.writeFileSync(process.env.RUN_JSON_OUT, JSON.stringify({
  script, label: label || null, k6_args: k6Args,
  base_url: `http://localhost:${port}`, api_cpus: apiCpus, k6_cpus: k6Cpus,
  started_at: startedAt, finished_at: finishedAt,
  k6_exit_code: Number(k6Exit), outcome,
  api_alive_at_end: apiAlive === "true",
  git: { commit, dirty: dirty === "true" },
  ...result,
  files: fs.readdirSync(outDir).filter((file) => !file.startsWith(".")).concat("run.json").sort(),
}, null, 2) + "\n");
' "$script" "$label" "$PORT" "$API_CPUS" "$K6_CPUS" "$started_at" "$finished_at" "$k6_exit" "$outcome" \
  "$api_alive" "$(git rev-parse --short HEAD)" "$([[ -n "$(git status --porcelain)" ]] && echo true || echo false)" \
  "$out_dir" "${k6_args[@]}"

log "k6 exited $k6_exit ($outcome). API still running at end: $api_alive."
verdict="$(node -e '
const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
if (r.breaking_point) console.log(JSON.stringify(r.breaking_point.verdict));' "$result_json")"
[[ -n "$verdict" ]] && log "Verdict: $verdict"
rm -f "$result_json"
[[ "$timeseries_exit" -eq 0 ]] || log "Time series extraction failed, see $out_dir/timeseries.err"
log "Output in $out_dir"
exit "$k6_exit"
