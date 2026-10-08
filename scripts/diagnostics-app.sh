# Starting and stopping the app for the diagnostic run scripts
# (profiling/run.sh, load-tests/run.sh), driven by the project manifest,
# .claude/diagnostics.json (see scripts/diagnostics-manifest.mjs).
#
# Source it from the project root, after defining log (print progress) and
# setup_failed (print a message and exit 2), then:
#   diag_load_manifest                 sets the DIAG_* variables
#   diag_build <log>                   builds, unless SKIP_BUILD=1 or no build
#   diag_start <log> <port> <cpus> [node args...]
#                                      starts the app pinned to <cpus>, with
#                                      the node args before its entry; sets
#                                      api_pid
#   diag_wait_ready <base-url> <log>   waits for the readiness path
#   diag_stop                          SIGTERMs the app and waits for it to
#                                      exit; returns 1 if it doesn't in time

diag_load_manifest() {
  local assignments
  assignments="$(node scripts/diagnostics-manifest.mjs shell)" \
    || setup_failed "Couldn't read the diagnostics manifest, see the error above"
  eval "$assignments"
}

diag_build() {
  local log="$1"
  if [[ "${SKIP_BUILD:-}" == "1" || -z "$DIAG_BUILD" ]]; then
    return
  fi
  log "Building ($DIAG_BUILD)..."
  bash -c "$DIAG_BUILD" > "$log" 2>&1 || setup_failed "Build failed, see $log"
}

diag_start() {
  local log="$1" port="$2" cpus="$3"
  shift 3
  env "${DIAG_ENV[@]}" "$DIAG_PORT_ENV=$port" taskset -c "$cpus" \
    node "${DIAG_NODE_ARGS[@]}" "$@" "$DIAG_ENTRY" > "$log" 2>&1 &
  api_pid=$!
}

diag_wait_ready() {
  local url="$1$DIAG_READY_PATH" log="$2"
  for _ in $(seq 1 $((DIAG_READY_TIMEOUT_S * 5))); do
    curl -sf "$url" > /dev/null && return
    kill -0 "$api_pid" 2>/dev/null || setup_failed "API exited on startup, see $log"
    sleep 0.2
  done
  curl -sf "$url" > /dev/null || setup_failed "API not ready ($url) after ${DIAG_READY_TIMEOUT_S}s, see $log"
}

diag_stop() {
  kill -TERM "$api_pid"
  for _ in $(seq 1 $((DIAG_SHUTDOWN_TIMEOUT_S * 10))); do
    kill -0 "$api_pid" 2>/dev/null || return 0
    sleep 0.1
  done
  ! kill -0 "$api_pid" 2>/dev/null
}
