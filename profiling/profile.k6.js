// k6 script that drives a fixed amount of work through the API while it is
// being profiled, using the project's workload (the request mix named in
// .claude/diagnostics.json).
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
//   SEED        records created in setup()       (default 100)
//   MAX_TIME    give up after this long          (default 5m)
import { loadWorkload } from '../load-tests/lib/workload.js';

const ITERATIONS = Number(__ENV.ITERATIONS || 20000);
const VUS = Number(__ENV.VUS || 10);
const SEED = Number(__ENV.SEED || 100);

const workload = loadWorkload({ baseUrl: __ENV.BASE_URL || 'http://localhost:3000' });

export const options = {
  scenarios: {
    workload: {
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
    workload.requestNames.flatMap((name) => [
      [`http_reqs{name:${name}}`, ['count>=0']],
      [`http_req_duration{name:${name}}`, ['max>=0']],
    ])
  ),
};

export const setup = () => workload.seed(SEED);

export default (seedData) => workload.iteration(seedData);
