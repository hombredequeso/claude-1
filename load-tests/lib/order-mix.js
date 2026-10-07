// The orders API request mix shared by the k6 tests in load-tests/.
//
// Each iteration picks one action at random, so writes and reads are spread
// through the whole run rather than clustered:
//   10% write: create an order, then cancel or complete it (50/50)
//   90% read:  30% list orders, 70% get a specific existing order
import http from 'k6/http';
import { check, fail } from 'k6';

const WRITE_RATIO = 0.1;
const LIST_RATIO_OF_READS = 0.3;
const CANCEL_RATIO_OF_WRITES = 0.5;

const JSON_HEADERS = { 'Content-Type': 'application/json' };

// timeout is how long k6 waits for each response (k6's own default is 60s).
export const createOrderMix = ({ baseUrl, timeout = '60s' }) => {
  // Requests to /orders/{id} are grouped under one name so per-id URLs don't
  // each become a separate metric series.
  const params = (name, headers = {}) => ({ headers, timeout, tags: { name } });

  const createOrder = (id) => {
    const res = http.post(
      `${baseUrl}/orders`,
      JSON.stringify({ id, description: `Load test order ${id}` }),
      params('POST /orders', JSON_HEADERS)
    );
    check(res, { 'create: status 201': (r) => r.status === 201 });
    return res;
  };

  const cancelOrder = (id) => {
    const res = http.post(`${baseUrl}/orders/${id}/cancel`, null, params('POST /orders/{id}/cancel'));
    check(res, {
      'cancel: status 200': (r) => r.status === 200,
      'cancel: status Cancelled': (r) => r.status === 200 && r.json('status') === 'Cancelled',
    });
  };

  const completeOrder = (id) => {
    const res = http.post(`${baseUrl}/orders/${id}/complete`, null, params('POST /orders/{id}/complete'));
    check(res, {
      'complete: status 200': (r) => r.status === 200,
      'complete: status Completed': (r) => r.status === 200 && r.json('status') === 'Completed',
    });
  };

  const listOrders = () => {
    const res = http.get(`${baseUrl}/orders`, params('GET /orders'));
    check(res, { 'list: status 200': (r) => r.status === 200 });
  };

  const getOrder = (id) => {
    const res = http.get(`${baseUrl}/orders/${id}`, params('GET /orders/{id}'));
    check(res, {
      'get: status 200': (r) => r.status === 200,
      'get: matching id': (r) => r.status === 200 && r.json('id') === id,
    });
  };

  // Orders created by this VU during the run. k6 VUs don't share memory, so
  // each VU can only add its own orders to the pool of ids it reads from.
  const ownOrderIds = [];

  const writeOrder = () => {
    const id = crypto.randomUUID();
    const res = createOrder(id);
    if (res.status !== 201) {
      return;
    }
    ownOrderIds.push(id);
    if (Math.random() < CANCEL_RATIO_OF_WRITES) {
      cancelOrder(id);
    } else {
      completeOrder(id);
    }
  };

  const readOrders = (seedIds) => {
    if (Math.random() < LIST_RATIO_OF_READS) {
      listOrders();
      return;
    }
    const index = Math.floor(Math.random() * (seedIds.length + ownOrderIds.length));
    getOrder(index < seedIds.length ? seedIds[index] : ownOrderIds[index - seedIds.length]);
  };

  // Call from setup(): seeds orders before the load starts so reads of
  // specific orders always have something to hit, even on a VU's first
  // iteration. Returns the seeded ids, to pass to runIteration.
  const seedOrders = (count) => {
    const ids = Array.from({ length: count }, () => crypto.randomUUID());
    const responses = http.batch(
      ids.map((id) => [
        'POST',
        `${baseUrl}/orders`,
        JSON.stringify({ id, description: `Seed order ${id}` }),
        params('setup: POST /orders', JSON_HEADERS),
      ])
    );
    const failed = responses.filter((res) => res.status !== 201).length;
    if (failed > 0) {
      fail(`setup: ${failed} of ${count} seed orders failed to create — is the API running at ${baseUrl}?`);
    }
    return ids;
  };

  const runIteration = (seedIds) => {
    if (Math.random() < WRITE_RATIO) {
      writeOrder();
    } else {
      readOrders(seedIds);
    }
  };

  return { seedOrders, runIteration };
};
