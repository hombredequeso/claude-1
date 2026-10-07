// k6 script that drives a fixed amount of work through the orders API while
// it is being profiled, using the request mix in load-tests/lib/order-mix.js.
//
// This isn't a load test: nothing is judged on latency or throughput. It runs
// a fixed number of iterations (shared-iterations), so every run does the same
// work and profiles from different runs can be compared. Run it with
// profiling/run.sh, which starts the API under the profiler.
//
// Overridable with env vars, e.g. `-e ITERATIONS=50000`:
//   BASE_URL    API base URL                     (default http://localhost:3000)
//   ITERATIONS  iterations, shared across VUs    (default 20000)
//   VUS         concurrent VUs                   (default 10)
//   SEED        orders created in setup()        (default 100)
//   MAX_TIME    give up after this long          (default 5m)
import { createOrderMix } from '../load-tests/lib/order-mix.js';

const ITERATIONS = Number(__ENV.ITERATIONS || 20000);
const VUS = Number(__ENV.VUS || 10);
const SEED = Number(__ENV.SEED || 100);

const { seedOrders, runIteration } = createOrderMix({ baseUrl: __ENV.BASE_URL || 'http://localhost:3000' });

// The request names order-mix.js tags each request with.
const REQUEST_NAMES = [
  'setup: POST /orders',
  'POST /orders',
  'POST /orders/{id}/cancel',
  'POST /orders/{id}/complete',
  'GET /orders',
  'GET /orders/{id}',
];

export const options = {
  scenarios: {
    orders: {
      executor: 'shared-iterations',
      vus: VUS,
      iterations: ITERATIONS,
      maxDuration: __ENV.MAX_TIME || '5m',
    },
  },
  // k6's summary only records tagged submetrics that have a threshold, so
  // these always-passing thresholds put each request type's count and
  // duration in the summary, for profiling/scripts/summarise.mjs.
  thresholds: Object.fromEntries(
    REQUEST_NAMES.flatMap((name) => [
      [`http_reqs{name:${name}}`, ['count>=0']],
      [`http_req_duration{name:${name}}`, ['max>=0']],
    ])
  ),
};

export const setup = () => ({ seedIds: seedOrders(SEED) });

export default ({ seedIds }) => runIteration(seedIds);
