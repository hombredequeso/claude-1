// k6 breaking-point test for the orders API: steps the request rate up until
// the API starts to fail, using the request mix in lib/order-mix.js.
//
// Run against the built API, restarted before each run so the in-memory store
// starts empty, with the API and k6 pinned to separate cores:
//   pnpm build && taskset -c 0,1 pnpm start
//   load-tests/monitor.sh                      # in a second terminal
//   K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_EXPORT=load-tests/reports/breaking-point.html \
//     taskset -c 2,3 k6 run load-tests/breaking-point.k6.js
//
// The rate is an open model (ramping-arrival-rate): iterations start on
// schedule whether or not earlier ones have finished, so a slowing API can't
// hold the load down. The rate goes up in steps, each held for STEP_SECONDS.
//
// Each request is tagged with its step's target rate (target_rps), and every
// step gets its own thresholds. Thresholds are evaluated over all the data a
// metric has seen, so a single run-wide threshold would be diluted by the
// healthy early steps; per-step thresholds judge each rate on its own. The
// test aborts at the first step that fails, and the first failing target_rps
// in the summary is the breaking point. A step fails when either:
//   - more than MAX_ERROR_RATE of its requests fail (timeouts included), or
//   - its p(95) latency is at or above MAX_P95_MS.
//
// Only a step's steady phase is judged. Iterations started in its first
// SETTLE_SECONDS (the ramp from the previous rate, plus any backlog spilling
// over from the previous step) are tagged step_phase:settling and left out of
// its thresholds, so a step fails on sustained behaviour at its own rate, not
// on a brief stall carried over from before it. Settling requests are still
// recorded, and still count in the run-wide metrics.
//
// If dropped_iterations is non-zero, k6 had no free VU when an iteration was
// due, so the target rate wasn't reached. A few during brief stalls means
// PRE_VUS was too low (k6 drops iterations while it creates VUs); many, with
// VUs at MAX_VUS, means the API has fallen behind, or k6 itself is the limit.
//
// A CPU-bound k6 falls short of the target rate without counting drops, so
// each step's steady-phase iteration count, and how far into its steady
// phase the run got (the breaking_point_steady_elapsed gauge), are also
// reported in the summary through always-passing thresholds.
// load-tests/scripts/run-result.mjs turns these into each step's achieved
// rate, and a verdict on whether the API or k6 was the limit.
//
// Overridable with env vars, e.g. `k6 run -e STEP_RPS=500 load-tests/breaking-point.k6.js`:
//   BASE_URL         API base URL                           (default http://localhost:3000)
//   START_RPS        iterations/s on the first step         (default 100)
//   STEP_RPS         iterations/s added each step           (default 250)
//   MAX_RPS          highest target rate                    (default 5000)
//   STEP_SECONDS     length of each step                    (default 30)
//   SETTLE_SECONDS   start of each step not judged          (default 10)
//   MAX_ERROR_RATE   failed-request rate that fails a step  (default 0.01)
//   MAX_P95_MS       p(95) latency that fails a step        (default 500)
//   TIMEOUT          per-request timeout                    (default 5s)
//   PRE_VUS          VUs allocated up front                 (default 1000)
//   MAX_VUS          most VUs k6 may use                    (default 2000)
//   SEED             orders created in setup()              (default 100)
import exec from 'k6/execution';
import { Gauge } from 'k6/metrics';
import { createOrderMix } from './lib/order-mix.js';

const START_RPS = Number(__ENV.START_RPS || 100);
const STEP_RPS = Number(__ENV.STEP_RPS || 250);
const MAX_RPS = Number(__ENV.MAX_RPS || 5000);
const STEP_SECONDS = Number(__ENV.STEP_SECONDS || 30);
const SETTLE_SECONDS = Number(__ENV.SETTLE_SECONDS || 10);
const MAX_ERROR_RATE = Number(__ENV.MAX_ERROR_RATE || 0.01);
const MAX_P95_MS = Number(__ENV.MAX_P95_MS || 500);
const SEED = Number(__ENV.SEED || 100);

// Time taken to move from one step's rate to the next, out of STEP_SECONDS.
const STEP_RAMP_SECONDS = 2;

if (SETTLE_SECONDS < STEP_RAMP_SECONDS || SETTLE_SECONDS >= STEP_SECONDS) {
  throw new Error(
    `SETTLE_SECONDS (${SETTLE_SECONDS}) must be at least ${STEP_RAMP_SECONDS} and less than STEP_SECONDS (${STEP_SECONDS})`
  );
}

const { seedOrders, runIteration } = createOrderMix({
  baseUrl: __ENV.BASE_URL || 'http://localhost:3000',
  timeout: __ENV.TIMEOUT || '5s',
});

const stepRates = Array.from(
  { length: Math.floor((MAX_RPS - START_RPS) / STEP_RPS) + 1 },
  (_, step) => START_RPS + step * STEP_RPS
);

const stepStages = (rate) => [
  { duration: `${STEP_RAMP_SECONDS}s`, target: rate },
  { duration: `${STEP_SECONDS - STEP_RAMP_SECONDS}s`, target: rate },
];

// Seconds into the current step's steady phase, set by each steady iteration.
const steadyElapsed = new Gauge('breaking_point_steady_elapsed');

const stepThresholds = (rate) => ({
  [`http_req_failed{target_rps:${rate},step_phase:steady}`]: [
    { threshold: `rate<${MAX_ERROR_RATE}`, abortOnFail: true, delayAbortEval: '5s' },
  ],
  [`http_req_duration{target_rps:${rate},step_phase:steady}`]: [
    { threshold: `p(95)<${MAX_P95_MS}`, abortOnFail: true, delayAbortEval: '5s' },
  ],
  // These always pass: they only make the step's steady-phase iteration count
  // and elapsed time appear in the summary.
  [`iterations{target_rps:${rate},step_phase:steady}`]: ['count>=0'],
  [`breaking_point_steady_elapsed{target_rps:${rate},step_phase:steady}`]: ['value>=0'],
});

export const options = {
  scenarios: {
    breaking_point: {
      executor: 'ramping-arrival-rate',
      startRate: START_RPS,
      timeUnit: '1s',
      preAllocatedVUs: Number(__ENV.PRE_VUS || 1000),
      maxVUs: Number(__ENV.MAX_VUS || 2000),
      stages: stepRates.flatMap(stepStages),
    },
  },
  thresholds: Object.assign(
    { dropped_iterations: ['count<1'] },
    ...stepRates.map(stepThresholds)
  ),
};

const currentStep = () => {
  const elapsedSeconds = (Date.now() - exec.scenario.startTime) / 1000;
  const step = Math.min(Math.floor(elapsedSeconds / STEP_SECONDS), stepRates.length - 1);
  const secondsIntoStep = elapsedSeconds - step * STEP_SECONDS;
  return { rate: stepRates[step], secondsIntoStep };
};

export const setup = () => ({ seedIds: seedOrders(SEED) });

export default ({ seedIds }) => {
  const { rate, secondsIntoStep } = currentStep();
  const steady = secondsIntoStep >= SETTLE_SECONDS;
  exec.vu.metrics.tags.target_rps = rate;
  exec.vu.metrics.tags.step_phase = steady ? 'steady' : 'settling';
  if (steady) {
    steadyElapsed.add(secondsIntoStep - SETTLE_SECONDS);
  }
  runIteration(seedIds);
};
