// k6 load test for the orders API: ramp up, hold at full load, ramp down,
// using the request mix in lib/order-mix.js.
//
// Run against a locally running API (`pnpm dev` or `pnpm start`):
//   k6 run load-tests/orders.k6.js
//
// Overridable with env vars, e.g. `k6 run -e VUS=100 -e HOLD=5m load-tests/orders.k6.js`:
//   BASE_URL   API base URL               (default http://localhost:3000)
//   VUS        VUs at full load           (default 50)
//   RAMP_UP    ramp-up duration           (default 30s)
//   HOLD       full-load duration         (default 2m)
//   RAMP_DOWN  ramp-down duration         (default 30s)
//   SEED       orders created in setup()  (default 100)
import { createOrderMix } from './lib/order-mix.js';

const VUS = Number(__ENV.VUS || 50);
const SEED = Number(__ENV.SEED || 100);

const { seedOrders, runIteration } = createOrderMix({ baseUrl: __ENV.BASE_URL || 'http://localhost:3000' });

export const options = {
  scenarios: {
    orders: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: __ENV.RAMP_UP || '30s', target: VUS },
        { duration: __ENV.HOLD || '2m', target: VUS },
        { duration: __ENV.RAMP_DOWN || '30s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
    checks: ['rate>0.99'],
  },
};

export const setup = () => ({ seedIds: seedOrders(SEED) });

export default ({ seedIds }) => runIteration(seedIds);
