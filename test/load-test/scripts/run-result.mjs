// Reads a run directory written by test/load-test/run.sh and prints the run's
// result as JSON, for run.sh to put in run.json.
//
// Usage: node test/load-test/scripts/run-result.mjs <run-dir> <k6-core-count>
//
// Reads summary.json (k6's legacy --summary-export format, in which a
// threshold's value is true when it was crossed) and, when present, the
// monitor's pidstat logs and run.txt.
//
// For any test it reports the thresholds that were crossed. For
// breaking-point.k6.js (recognised by its per-step steady-phase metrics) it
// also reports each step's steady phase, and a verdict:
//   api_limit_found     a step failed its latency or error thresholds, and k6
//                       wasn't the limit; at_failure.api_main_thread_saturated
//                       false means the API wasn't CPU-bound either, so check
//                       for interference (vmstat.log) or slow work that isn't
//                       CPU, before taking the failing rate as the API's limit
//   k6_limit_reached    k6 couldn't deliver the load: either a step fell short
//                       of its target rate, or a step failed while k6 was at its
//                       CPU limit and the API's main thread wasn't (a CPU-bound
//                       k6 reads responses late, inflating measured latency)
//   no_limit_found      every step passed at its full target rate
//
// Each step also gets the API main thread's and k6's average CPU over its
// steady phase, from the monitor's pidstat logs. The same rate at lower API
// CPU means more headroom, which shows a change in throughput even when the
// run doesn't find the API's limit.
//
// Each step's status is one of:
//   ok             passed, at (nearly) the full target rate
//   api_failed     its latency or error-rate threshold was crossed
//   k6_shortfall   passed, but the achieved rate was under KEPT_UP_RATIO of target
//   not_reached    the run stopped before the step's steady phase
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Achieved/target rate below which k6 is judged not to have kept up.
const KEPT_UP_RATIO = 0.97;
// Share of its CPU limit at which a process is judged to be saturated: k6's
// limit is 100% per core it was given, the API main thread's is 100%.
const SATURATED_RATIO = 0.9;
// CPU at the failure is averaged over the run's final seconds of pidstat
// samples (a failed step stops the run, so it is the run's last step): as
// many seconds as the failing step's steady phase ran, within these bounds,
// so a failure early in a step isn't averaged with the step before it.
const MIN_FAILURE_SAMPLES = 3;
const MAX_FAILURE_SAMPLES = 10;
// Fewest pidstat samples a step's steady phase needs for its CPU figures.
const MIN_STEP_SAMPLES = 3;

const STEP_METRIC =
  /^(http_req_duration|http_req_failed|iterations|breaking_point_steady_elapsed|breaking_point_steady_start)\{target_rps:(\d+),step_phase:steady\}$/;

const round = (value, places) =>
  value === undefined || value === null || Number.isNaN(value) ? null : Number(value.toFixed(places));

const average = (values) => (values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length);

const crossedThresholds = (metrics) =>
  Object.entries(metrics).flatMap(([name, metric]) =>
    Object.entries(metric.thresholds ?? {})
      .filter(([, crossed]) => crossed)
      .map(([expression]) => `${name}: ${expression}`)
  );

const isCrossed = (metric) => Object.values(metric?.thresholds ?? {}).some((crossed) => crossed);

const stepRates = (metrics) =>
  [
    ...new Set(
      Object.keys(metrics)
        .map((name) => name.match(STEP_METRIC))
        .filter((match) => match !== null)
        .map((match) => Number(match[2]))
    ),
  ].sort((a, b) => a - b);

const stepMetrics = (metrics, rate) => {
  const tagged = (metric) => metrics[`${metric}{target_rps:${rate},step_phase:steady}`];
  return {
    duration: tagged('http_req_duration'),
    failed: tagged('http_req_failed'),
    iterations: tagged('iterations'),
    elapsed: tagged('breaking_point_steady_elapsed'),
    start: tagged('breaking_point_steady_start'),
  };
};

const stepStatus = ({ reached, apiFailed, achievedRatio }) => {
  if (!reached) {
    return 'not_reached';
  }
  if (apiFailed) {
    return 'api_failed';
  }
  return achievedRatio !== null && achievedRatio < KEPT_UP_RATIO ? 'k6_shortfall' : 'ok';
};

// pidstat's sample at time T covers the second before it, so a steady phase
// from startMs, seconds long, has the samples timed after startMs + 1 s up to
// its end.
const stepCpu = (monitor, startMs, seconds) => {
  const empty = { api_main_thread_cpu_pct: null, k6_cpu_pct: null, cpu_seconds_sampled: 0 };
  if (monitor === null || startMs === undefined || seconds <= 0) {
    return empty;
  }
  const inStep = (sample) => sample.timeMs >= startMs + 1000 && sample.timeMs <= startMs + seconds * 1000;
  const k6 = monitor.k6Samples.filter(inStep);
  const apiMain = monitor.apiMainSamples.filter(inStep);
  if (k6.length < MIN_STEP_SAMPLES || apiMain.length < MIN_STEP_SAMPLES) {
    return empty;
  }
  return {
    api_main_thread_cpu_pct: round(average(apiMain.map((sample) => sample.cpu)), 0),
    k6_cpu_pct: round(average(k6.map((sample) => sample.cpu)), 0),
    cpu_seconds_sampled: apiMain.length,
  };
};

// The achieved rate is the steady-phase iteration count over how far into its
// steady phase the step got, so it is known for a step the run stopped in too.
const toStep = (metrics, monitor, rate) => {
  const { duration, failed, iterations, elapsed, start } = stepMetrics(metrics, rate);
  const count = iterations?.count ?? 0;
  const reached = count > 0;
  const elapsedSeconds = elapsed?.max ?? 0;
  const achievedRps = reached && elapsedSeconds > 0 ? count / elapsedSeconds : null;
  const achievedRatio = achievedRps === null ? null : achievedRps / rate;
  const cpu = stepCpu(monitor, start?.value, elapsedSeconds);
  return {
    target_rps: rate,
    status: stepStatus({ reached, apiFailed: isCrossed(duration) || isCrossed(failed), achievedRatio }),
    achieved_rps: round(achievedRps, 1),
    achieved_ratio: round(achievedRatio, 3),
    steady_seconds: round(elapsedSeconds, 1),
    steady_iterations: count,
    p95_ms: reached ? round(duration?.['p(95)'], 2) : null,
    median_ms: reached ? round(duration?.med, 2) : null,
    failed_rate: reached ? round(failed?.value, 4) : null,
    api_main_thread_cpu_pct: cpu.api_main_thread_cpu_pct,
    k6_cpu_pct: cpu.k6_cpu_pct,
    cpu_seconds_sampled: cpu.cpu_seconds_sampled,
  };
};

// pidstat lines start with a HH:MM:SS time; comment and header lines don't.
const pidstatRows = (text) =>
  text
    .split('\n')
    .filter((line) => /^\d\d:\d\d:\d\d\s/.test(line))
    .map((line) => line.trim().split(/\s+/));

// pidstat.log columns: Time UID PID %usr %system %guest %wait %CPU ...
// pidstat-threads.log columns: Time UID TGID TID %usr %system %guest %wait %CPU ...
const finalCpu = ({ k6Rows, apiMainRows }, sampleCount) => {
  const finalK6Rows = k6Rows.slice(-sampleCount);
  const finalTimes = new Set(finalK6Rows.map((row) => row[0]));
  return {
    k6Cpu: average(finalK6Rows.map((row) => Number(row[7]))),
    apiMainCpu: average(apiMainRows.filter((row) => finalTimes.has(row[0])).map((row) => Number(row[8]))),
    seconds: finalK6Rows.length,
  };
};

const secondsOfDay = (time) => {
  const [hours, minutes, seconds] = time.split(':').map(Number);
  return hours * 3600 + minutes * 60 + seconds;
};

// pidstat times are local times of day. A run is shorter than a day, so a
// time earlier than when monitoring started is on the next day.
const timedSamples = (rows, start, cpuColumn) => {
  const startSeconds = secondsOfDay(start.time);
  const dayMs = (offset) => new Date(start.year, start.month - 1, start.day + offset).getTime();
  return rows.map((row) => {
    const seconds = secondsOfDay(row[0]);
    return { timeMs: dayMs(seconds < startSeconds ? 1 : 0) + seconds * 1000, cpu: Number(row[cpuColumn]) };
  });
};

const readMonitor = (runDir) => {
  const path = (file) => join(runDir, file);
  if (!['run.txt', 'pidstat.log', 'pidstat-threads.log'].every((file) => existsSync(path(file)))) {
    return null;
  }
  const runTxt = readFileSync(path('run.txt'), 'utf8');
  const field = (name) => runTxt.match(new RegExp(`^${name}: (\\d+)$`, 'm'))?.[1];
  const [apiPid, k6Pid] = [field('api_pid'), field('k6_pid')];
  const startMatch = runTxt.match(/^start: (\d{4})-(\d\d)-(\d\d) (\d\d:\d\d:\d\d)$/m);
  const k6Rows = pidstatRows(readFileSync(path('pidstat.log'), 'utf8')).filter((row) => row[2] === k6Pid);
  const apiMainRows = pidstatRows(readFileSync(path('pidstat-threads.log'), 'utf8')).filter((row) => row[3] === apiPid);
  const start =
    startMatch === null
      ? null
      : { year: Number(startMatch[1]), month: Number(startMatch[2]), day: Number(startMatch[3]), time: startMatch[4] };
  return {
    k6Rows,
    apiMainRows,
    k6Samples: start === null ? [] : timedSamples(k6Rows, start, 7),
    apiMainSamples: start === null ? [] : timedSamples(apiMainRows, start, 8),
  };
};

const atBreak = (monitor, failing, k6CoreCount) => {
  const sampleCount = Math.min(
    MAX_FAILURE_SAMPLES,
    Math.max(MIN_FAILURE_SAMPLES, Math.ceil(failing.steady_seconds ?? 0))
  );
  const cpu = monitor === null ? null : finalCpu(monitor, sampleCount);
  if (cpu === null || cpu.k6Cpu === null || cpu.apiMainCpu === null) {
    return {
      seconds_sampled: 0,
      k6_cpu_pct: null,
      k6_cpu_limit_pct: k6CoreCount * 100,
      api_main_thread_cpu_pct: null,
      api_main_thread_saturated: null,
      k6_was_limit: null,
    };
  }
  const k6Saturated = cpu.k6Cpu >= SATURATED_RATIO * k6CoreCount * 100;
  const apiSaturated = cpu.apiMainCpu >= SATURATED_RATIO * 100;
  return {
    seconds_sampled: cpu.seconds,
    k6_cpu_pct: round(cpu.k6Cpu, 0),
    k6_cpu_limit_pct: k6CoreCount * 100,
    api_main_thread_cpu_pct: round(cpu.apiMainCpu, 0),
    api_main_thread_saturated: apiSaturated,
    k6_was_limit: k6Saturated && !apiSaturated,
  };
};

const toVerdict = (steps, monitor, k6CoreCount) => {
  const failing = steps.find((step) => step.status === 'api_failed');
  const shortfalls = steps.filter((step) => step.status === 'k6_shortfall').map((step) => step.target_rps);
  const highestPassed = steps.filter((step) => step.status === 'ok' || step.status === 'k6_shortfall').at(-1);
  const common = {
    highest_passing_step_rps: highestPassed?.target_rps ?? null,
    k6_shortfall_steps_rps: shortfalls,
  };
  if (failing !== undefined) {
    // A failing step falls short of its rate whichever side is the limit (a
    // slow API ties up VUs), so only CPU at the failure tells them apart.
    const resources = atBreak(monitor, failing, k6CoreCount);
    return {
      result: resources.k6_was_limit === true ? 'k6_limit_reached' : 'api_limit_found',
      failing_step_rps: failing.target_rps,
      failing_step_achieved_ratio: failing.achieved_ratio,
      ...common,
      at_failure: resources,
    };
  }
  if (shortfalls.length > 0) {
    return { result: 'k6_limit_reached', first_k6_shortfall_rps: shortfalls[0], ...common };
  }
  return { result: 'no_limit_found', ...common };
};

const toResult = (summary, monitor, k6CoreCount) => {
  const { metrics } = summary;
  const result = { thresholds_crossed: crossedThresholds(metrics) };
  const rates = stepRates(metrics);
  if (rates.length === 0) {
    return result;
  }
  const steps = rates.map((rate) => toStep(metrics, monitor, rate));
  return {
    ...result,
    breaking_point: { verdict: toVerdict(steps, monitor, k6CoreCount), kept_up_ratio: KEPT_UP_RATIO, steps },
  };
};

const [runDir, k6CoreCountArg] = process.argv.slice(2);
if (runDir === undefined || k6CoreCountArg === undefined) {
  console.error('Usage: node test/load-test/scripts/run-result.mjs <run-dir> <k6-core-count>');
  process.exit(1);
}
const summary = JSON.parse(readFileSync(join(runDir, 'summary.json'), 'utf8'));
process.stdout.write(JSON.stringify(toResult(summary, readMonitor(runDir), Number(k6CoreCountArg)), null, 2) + '\n');
