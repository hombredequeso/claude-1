// Extracts the per-period time series (10s by default) from a k6 web
// dashboard HTML export into CSV, so it can be read without a browser.
//
// Usage: node load-tests/scripts/dashboard-timeseries.mjs <dashboard.html> > timeseries.csv
//
// The export embeds its data as gzipped, base64-encoded newline-delimited
// JSON events. `metric` events register metric names; each `snapshot` event
// is an array of per-period aggregates, indexed by the registered names in
// sorted order. Trend aggregates are [avg, max, med, min, p(90), p(95), p(99)],
// counters [count, rate], rates [rate] and gauges [value].
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const TREND = { avg: 0, max: 1, med: 2, min: 3, p90: 4, p95: 5, p99: 6 };
const COUNTER = { count: 0, rate: 1 };

// [column, metric, aggregate index, decimal places]. Counters only appear once
// first incremented, so a missing counter is reported as 0.
const COLUMNS = [
  ['reqs_per_s', 'http_reqs', COUNTER.rate, 1],
  ['iters_per_s', 'iterations', COUNTER.rate, 1],
  ['dropped_iters_per_s', 'dropped_iterations', COUNTER.rate, 1],
  ['failed_rate', 'http_req_failed', 0, 4],
  ['vus', 'vus', 0, 0],
  ['vus_max', 'vus_max', 0, 0],
  ['duration_avg_ms', 'http_req_duration', TREND.avg, 2],
  ['duration_med_ms', 'http_req_duration', TREND.med, 2],
  ['duration_p90_ms', 'http_req_duration', TREND.p90, 2],
  ['duration_p95_ms', 'http_req_duration', TREND.p95, 2],
  ['duration_p99_ms', 'http_req_duration', TREND.p99, 2],
  ['duration_min_ms', 'http_req_duration', TREND.min, 2],
  ['duration_max_ms', 'http_req_duration', TREND.max, 2],
  ['waiting_p95_ms', 'http_req_waiting', TREND.p95, 2],
  ['receiving_p95_ms', 'http_req_receiving', TREND.p95, 3],
  ['blocked_p95_ms', 'http_req_blocked', TREND.p95, 3],
  ['connecting_max_ms', 'http_req_connecting', TREND.max, 2],
  ['iteration_duration_p95_ms', 'iteration_duration', TREND.p95, 2],
];

const readEvents = (htmlPath) => {
  const html = readFileSync(htmlPath, 'utf8');
  const match = html.match(/<script id="data"[^>]*>([^<]*)<\/script>/);
  if (match === null) {
    throw new Error(`${htmlPath} has no embedded k6 dashboard data`);
  }
  return gunzipSync(Buffer.from(match[1].trim(), 'base64'))
    .toString('utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
};

// Snapshots are positional, so each one is read against the metric names
// registered before it. `names` only changes on the few `metric` events.
const toSnapshots = (events) => {
  let names = [];
  return events.flatMap((event) => {
    switch (event.event) {
      case 'metric':
        names = [...names, ...Object.keys(event.data)].sort();
        return [];
      case 'start':
      case 'snapshot':
        return [{ kind: event.event, values: new Map(names.map((name, index) => [name, event.data[index] ?? []])) }];
      default:
        return [];
    }
  });
};

const COUNTERS = new Set(['http_reqs', 'iterations', 'dropped_iterations']);

const format = (value, places) => (value === undefined ? '' : Number(value).toFixed(places));

const toCsv = (snapshots) => {
  const startTime = snapshots.find((s) => s.kind === 'start').values.get('time')[0];
  const rows = snapshots
    .filter((s) => s.kind === 'snapshot')
    .map(({ values }) => {
      const time = values.get('time')[0];
      return [
        Math.round((time - startTime) / 1000),
        new Date(time).toISOString(),
        ...COLUMNS.map(([, metric, index, places]) =>
          format(values.get(metric)?.[index] ?? (COUNTERS.has(metric) ? 0 : undefined), places)
        ),
      ].join(',');
    });
  return [['elapsed_s', 'time', ...COLUMNS.map(([column]) => column)].join(','), ...rows].join('\n') + '\n';
};

const [htmlPath] = process.argv.slice(2);
if (htmlPath === undefined) {
  console.error('Usage: node load-tests/scripts/dashboard-timeseries.mjs <dashboard.html>');
  process.exit(1);
}
process.stdout.write(toCsv(toSnapshots(readEvents(htmlPath))));
