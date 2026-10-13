// Compares two breaking-point run directories written by
// test/load-test/run.sh, from the run.json in each, and writes comparison.md
// into the after run's directory: whether the API's throughput limit, its
// CPU cost per iteration and its latency changed by more than run-to-run
// noise.
//
// Usage: node test/load-test/scripts/compare.mjs <before-run-dir> <after-run-dir>
//
// Three measures, each judged against noise allowances calibrated on
// back-to-back runs of the same code (see the allowances below):
//
//   The limit: the first step whose latency or error rate failed while k6
//   kept up (verdict api_limit_found). Steps are discrete, so a change is
//   clear only when it is more than LIMIT_NOISE_STEPS steps. A run that
//   didn't find the limit (k6 ran out of CPU first, or every step passed)
//   only shows that the limit is above its highest clean step, so a change
//   against it is clear only when it holds against that bound.
//
//   API CPU per iteration: the API main thread's CPU over the steady phases
//   of the steps both runs passed cleanly, divided by the iterations in
//   them, i.e. main-thread CPU ms per iteration. The main thread is what
//   saturates first, so this is what sets the limit: the same rate at lower
//   CPU means more headroom. It shows a change in throughput even when
//   neither run found the limit. Pooling over the steps weights them by
//   iterations, so the busier steps count most.
//
//   Latency: each matched step's p95 and median, after/before, combined as
//   a geometric mean over the matched steps. Latency at a step depends on
//   both sides of the connection, so a k6 near its CPU limit inflates it;
//   steps where either run's k6 was near its limit are left out.
//
// Also checks the runs are comparable: the same script, workload, k6 args
// and core split, both completed (no k6 error), the API alive at the end,
// and the same machine conditions. CPU per iteration moves with CPU clock
// speed and with whatever else is running, by far more than the noise
// between back-to-back runs (twice as much across sessions on the same
// laptop). k6 does the same work per iteration whatever the API does, so its
// CPU per iteration is the control: if it moved by more than
// K6_CONTROL_NOISE_RATIO, the machine changed, and so would the API's.
//
// Exits 0 if the comparison was written and the runs are comparable, 1 if it
// was written but they aren't (comparison.md says why), 2 if it couldn't be
// made. The last line printed is the path of comparison.md.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';

// Noise allowances, from three back-to-back default runs of the same code
// (the noise-* runs in test/load-test/reports, 2026-10-13, on a 4-core laptop
// on battery with a desktop session running). Across their three pairs, the
// biggest differences were: API CPU per iteration ×1.075, k6 CPU per
// iteration ×1.04, p95 geometric mean ×1.31. Each allowance is about twice
// the biggest difference seen (squared, as a ratio), since three pairs is a
// small sample. All three runs were k6-limited and stopped at the same step,
// so the limit's allowance is a judgement, not calibrated: one step.
const LIMIT_NOISE_STEPS = 1;
const CPU_NOISE_RATIO = 1.15;
const K6_CONTROL_NOISE_RATIO = 1.1;
const LATENCY_NOISE_RATIO = 1.75;
const NOISE_CALIBRATION =
  'in three back-to-back runs, API CPU per iteration differed by up to ×1.075, k6 CPU per iteration by ' +
  'up to ×1.04 and the p95 geometric mean by up to ×1.31, and each allowance is about twice that. None of ' +
  'those runs found the API limit (k6 ran out of CPU first), so the limit\'s allowance of one step is a ' +
  'judgement, not calibrated.';

// A step is left out of the latency comparison when either run's k6 was at
// or above this share of its CPU limit there.
const K6_BUSY_RATIO = 0.8;

const StepSchema = z.object({
  target_rps: z.number(),
  status: z.enum(['ok', 'api_failed', 'k6_shortfall', 'not_reached']),
  achieved_rps: z.number().nullable(),
  steady_seconds: z.number().nullable(),
  steady_iterations: z.number(),
  p95_ms: z.number().nullable(),
  median_ms: z.number().nullable(),
  failed_rate: z.number().nullable(),
  // Missing from runs made before per-step CPU was recorded.
  api_main_thread_cpu_pct: z.number().nullable().optional(),
  k6_cpu_pct: z.number().nullable().optional(),
});

const RunSchema = z.object({
  script: z.string(),
  label: z.string().nullable(),
  workload: z.string(),
  k6_args: z.array(z.string()),
  api_cpus: z.string(),
  k6_cpus: z.string(),
  started_at: z.string(),
  outcome: z.string(),
  api_alive_at_end: z.boolean(),
  git: z.object({ commit: z.string(), dirty: z.boolean() }),
  breaking_point: z.object({
    verdict: z.object({
      result: z.enum(['api_limit_found', 'k6_limit_reached', 'no_limit_found']),
      failing_step_rps: z.number().optional(),
    }),
    steps: z.array(StepSchema),
  }),
});

// --- Pure: comparison -------------------------------------------------------

const stepSize = (steps) => (steps.length < 2 ? null : steps[1].target_rps - steps[0].target_rps);

// k6's CPU limit is 100% per core it was given.
const k6CpuLimitPct = (run) => run.k6_cpus.split(',').length * 100;

const highestOkStep = (steps) => steps.filter((step) => step.status === 'ok').at(-1)?.target_rps ?? null;

// What a run shows about the API's limit: where it was found, or only that
// it is above the highest step passed cleanly.
const limitOf = (run) => {
  const { verdict, steps } = run.breaking_point;
  if (verdict.result === 'api_limit_found') {
    return { kind: 'Found', failingRps: verdict.failing_step_rps, highestOkRps: highestOkStep(steps) };
  }
  return { kind: 'Above', highestOkRps: highestOkStep(steps), limitedBy: verdict.result };
};

const limitVerdict = (before, after, noiseRps) => {
  if (before.kind === 'Found' && after.kind === 'Found') {
    const change = after.failingRps - before.failingRps;
    if (Math.abs(change) <= noiseRps) {
      return 'NoClearChange';
    }
    return change > 0 ? 'Higher' : 'Lower';
  }
  if (before.kind === 'Found' && after.kind === 'Above') {
    return (after.highestOkRps ?? 0) - before.failingRps > noiseRps ? 'Higher' : 'Unresolved';
  }
  if (before.kind === 'Above' && after.kind === 'Found') {
    return (before.highestOkRps ?? 0) - after.failingRps > noiseRps ? 'Lower' : 'Unresolved';
  }
  return 'NotFound';
};

const compareLimit = (before, after) => {
  const step = stepSize(before.breaking_point.steps);
  const noiseRps = step === null ? 0 : LIMIT_NOISE_STEPS * step;
  const beforeLimit = limitOf(before);
  const afterLimit = limitOf(after);
  return { before: beforeLimit, after: afterLimit, noiseRps, verdict: limitVerdict(beforeLimit, afterLimit, noiseRps) };
};

// Steps both runs passed cleanly, paired by target rate.
const matchedSteps = (before, after) => {
  const afterByRate = new Map(after.breaking_point.steps.map((step) => [step.target_rps, step]));
  return before.breaking_point.steps
    .filter((step) => step.status === 'ok' && afterByRate.get(step.target_rps)?.status === 'ok')
    .map((step) => ({ rate: step.target_rps, before: step, after: afterByRate.get(step.target_rps) }));
};

const hasCpu = (step) =>
  step.api_main_thread_cpu_pct !== null &&
  step.api_main_thread_cpu_pct !== undefined &&
  step.k6_cpu_pct !== null &&
  step.k6_cpu_pct !== undefined &&
  step.steady_iterations > 0;

// CPU ms per iteration over a set of steps, from each step's CPU percentage.
const cpuMsPerIteration = (steps, cpuPctOf) => {
  const iterations = steps.reduce((sum, step) => sum + step.steady_iterations, 0);
  const cpuMs = steps.reduce((sum, step) => sum + (cpuPctOf(step) / 100) * step.steady_seconds * 1000, 0);
  return iterations === 0 ? null : cpuMs / iterations;
};

const apiCpuPct = (step) => step.api_main_thread_cpu_pct;
const k6CpuPct = (step) => step.k6_cpu_pct;

const ratioOf = (before, after) => (before === null || after === null || before === 0 ? null : after / before);

const ratioVerdict = (ratio, noiseRatio) => {
  if (ratio === null) {
    return 'NoData';
  }
  if (ratio > noiseRatio) {
    return 'Higher';
  }
  return ratio < 1 / noiseRatio ? 'Lower' : 'NoClearChange';
};

const compareCpu = (pairs) => {
  const withCpu = pairs.filter((pair) => hasCpu(pair.before) && hasCpu(pair.after));
  const beforeSteps = withCpu.map((pair) => pair.before);
  const afterSteps = withCpu.map((pair) => pair.after);
  const before = cpuMsPerIteration(beforeSteps, apiCpuPct);
  const after = cpuMsPerIteration(afterSteps, apiCpuPct);
  const ratio = ratioOf(before, after);
  const k6Before = cpuMsPerIteration(beforeSteps, k6CpuPct);
  const k6After = cpuMsPerIteration(afterSteps, k6CpuPct);
  const k6Ratio = ratioOf(k6Before, k6After);
  return {
    steps: withCpu.length,
    before,
    after,
    ratio,
    verdict: ratioVerdict(ratio, CPU_NOISE_RATIO),
    k6Before,
    k6After,
    k6Ratio,
    k6Verdict: ratioVerdict(k6Ratio, K6_CONTROL_NOISE_RATIO),
  };
};

const geometricMean = (values) =>
  values.length === 0 ? null : Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length);

const k6Busy = (step, limitPct) =>
  step.k6_cpu_pct !== null && step.k6_cpu_pct !== undefined && step.k6_cpu_pct >= K6_BUSY_RATIO * limitPct;

const latencyRatio = (pairs, field) =>
  geometricMean(
    pairs.filter((pair) => pair.before[field] > 0 && pair.after[field] > 0).map((pair) => pair.after[field] / pair.before[field])
  );

const compareLatency = (pairs, before, after) => {
  const kept = pairs.filter(
    (pair) => !k6Busy(pair.before, k6CpuLimitPct(before)) && !k6Busy(pair.after, k6CpuLimitPct(after))
  );
  const p95Ratio = latencyRatio(kept, 'p95_ms');
  return {
    steps: kept.length,
    leftOut: pairs.length - kept.length,
    p95Ratio,
    medianRatio: latencyRatio(kept, 'median_ms'),
    verdict: ratioVerdict(p95Ratio, LATENCY_NOISE_RATIO),
  };
};

const problemIf = (condition, problem) => (condition ? problem : null);

const machineProblem = (cpu) =>
  cpu.k6Verdict === 'Higher' || cpu.k6Verdict === 'Lower'
    ? `Machine conditions differ: k6's CPU per iteration, for the same work, changed ${ratioCell(cpu.k6Ratio)}, ` +
      'so CPU speed or other load on the machine changed between the runs, and API CPU per iteration and ' +
      'latency will have moved with it. Re-run both in the same conditions.'
    : null;

// Reasons the runs can't be compared like for like.
const comparabilityProblems = (before, after, cpu) =>
  [
    problemIf(basename(before.script) !== basename(after.script), `Scripts differ: ${before.script} before, ${after.script} after.`),
    problemIf(before.workload !== after.workload, `Workloads differ: ${before.workload} before, ${after.workload} after.`),
    problemIf(
      before.k6_args.join(' ') !== after.k6_args.join(' '),
      `k6 args differ: \`${before.k6_args.join(' ') || '(none)'}\` before, \`${after.k6_args.join(' ') || '(none)'}\` after.`
    ),
    problemIf(
      before.api_cpus !== after.api_cpus || before.k6_cpus !== after.k6_cpus,
      `Core splits differ: API ${before.api_cpus} / k6 ${before.k6_cpus} before, ` +
        `API ${after.api_cpus} / k6 ${after.k6_cpus} after.`
    ),
    problemIf(before.outcome === 'k6_error', 'k6 errored in the before run, so it may not have run to completion.'),
    problemIf(after.outcome === 'k6_error', 'k6 errored in the after run, so it may not have run to completion.'),
    problemIf(!before.api_alive_at_end, 'The API had exited by the end of the before run.'),
    problemIf(!after.api_alive_at_end, 'The API had exited by the end of the after run.'),
    problemIf(
      Date.parse(before.started_at) > Date.parse(after.started_at),
      'The after run started before the before run: check the order of the arguments.'
    ),
    problemIf(
      !before.breaking_point.steps.some(hasCpu) || !after.breaking_point.steps.some(hasCpu),
      'A run has no per-step CPU (it predates it, or its monitor logs are missing), so CPU per iteration ' +
        "can't be compared."
    ),
    machineProblem(cpu),
  ].filter((problem) => problem !== null);

const compareRuns = (before, after) => {
  const pairs = matchedSteps(before, after);
  const cpu = compareCpu(pairs);
  return {
    problems: comparabilityProblems(before, after, cpu),
    limit: compareLimit(before, after),
    cpu,
    latency: compareLatency(pairs, before, after),
    pairs,
  };
};

// --- Pure: rendering --------------------------------------------------------

const table = (headers, rows) =>
  [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`]
    .concat(rows.map((row) => `| ${row.join(' | ')} |`))
    .join('\n');

const verdictCell = (verdict) => {
  switch (verdict) {
    case 'Higher':
      return '**higher**';
    case 'Lower':
      return '**lower**';
    case 'NoClearChange':
      return 'no clear change';
    case 'Unresolved':
      return 'unresolved (one run only bounds the limit)';
    case 'NotFound':
      return 'not found in either run';
    case 'NoData':
      return 'no data';
    default:
      throw verdict;
  }
};

const limitCell = (limit) => {
  switch (limit.kind) {
    case 'Found':
      return `${limit.failingRps} rps failed (highest clean step ${limit.highestOkRps ?? 'none'})`;
    case 'Above':
      return `not found: above ${limit.highestOkRps ?? 'none'} rps (${limit.limitedBy})`;
    default:
      throw limit;
  }
};

const ratioCell = (ratio) =>
  ratio === null ? 'n/a' : `×${ratio.toFixed(2)} (${ratio >= 1 ? '+' : '−'}${Math.abs((ratio - 1) * 100).toFixed(0)}%)`;

const number = (value, places) => (value === null || value === undefined ? '–' : value.toFixed(places));

// The rate at which the main thread would reach 100%, if CPU per iteration
// stayed the same at higher rates. Only a rough guide: it usually rises a
// little near saturation.
const projectedRps = (msPerIteration) => (msPerIteration === null || msPerIteration === 0 ? null : 1000 / msPerIteration);

const renderSummary = ({ limit, cpu, latency }) =>
  table(
    ['', 'Before', 'After', 'Change', 'Noise', 'Verdict'],
    [
      [
        'Limit',
        limitCell(limit.before),
        limitCell(limit.after),
        limit.before.kind === 'Found' && limit.after.kind === 'Found'
          ? `${limit.after.failingRps - limit.before.failingRps >= 0 ? '+' : '−'}${Math.abs(limit.after.failingRps - limit.before.failingRps)} rps`
          : '',
        `±${limit.noiseRps} rps (${LIMIT_NOISE_STEPS} step${LIMIT_NOISE_STEPS === 1 ? '' : 's'})`,
        verdictCell(limit.verdict),
      ],
      [
        `API CPU ms per iteration (${cpu.steps} steps)`,
        number(cpu.before, 3),
        number(cpu.after, 3),
        ratioCell(cpu.ratio),
        `×${CPU_NOISE_RATIO.toFixed(2)}`,
        verdictCell(cpu.verdict),
      ],
      [
        `k6 CPU ms per iteration (control: machine conditions)`,
        number(cpu.k6Before, 3),
        number(cpu.k6After, 3),
        ratioCell(cpu.k6Ratio),
        `×${K6_CONTROL_NOISE_RATIO.toFixed(2)}`,
        cpu.k6Verdict === 'NoClearChange' ? 'same conditions' : verdictCell(cpu.k6Verdict),
      ],
      [
        'Projected main-thread saturation',
        `${number(projectedRps(cpu.before), 0)} rps`,
        `${number(projectedRps(cpu.after), 0)} rps`,
        '',
        '',
        'follows CPU per iteration',
      ],
      [
        `p95 latency, geometric mean of ratios (${latency.steps} steps)`,
        '',
        '',
        ratioCell(latency.p95Ratio),
        `×${LATENCY_NOISE_RATIO.toFixed(2)}`,
        verdictCell(latency.verdict),
      ],
      [`Median latency, same steps`, '', '', ratioCell(latency.medianRatio), '', 'not judged'],
    ]
  );

const stepRow = (rate, before, after) => [
  rate,
  `${before.status} / ${after.status}`,
  `${number(before.achieved_rps, 0)} / ${number(after.achieved_rps, 0)}`,
  `${number(before.p95_ms, 1)} / ${number(after.p95_ms, 1)}`,
  `${number(before.median_ms, 2)} / ${number(after.median_ms, 2)}`,
  `${number(before.api_main_thread_cpu_pct, 0)} / ${number(after.api_main_thread_cpu_pct, 0)}`,
  `${number(before.k6_cpu_pct, 0)} / ${number(after.k6_cpu_pct, 0)}`,
];

// A step one run's script didn't have.
const ABSENT_STEP = { status: 'absent', achieved_rps: null, p95_ms: null, median_ms: null };

const renderSteps = (before, after) => {
  const beforeByRate = new Map(before.breaking_point.steps.map((step) => [step.target_rps, step]));
  const afterByRate = new Map(after.breaking_point.steps.map((step) => [step.target_rps, step]));
  const rates = Array.from(new Set(Array.from(beforeByRate.keys()).concat(Array.from(afterByRate.keys())))).sort(
    (a, b) => a - b
  );
  return table(
    ['Target rps', 'Status', 'Achieved rps', 'p95 ms', 'Median ms', 'API main thread %', 'k6 CPU %'],
    rates.map((rate) => stepRow(rate, beforeByRate.get(rate) ?? ABSENT_STEP, afterByRate.get(rate) ?? ABSENT_STEP))
  );
};

const runLine = (which, dir, run) =>
  `- **${which}**: \`${dir}\`, commit \`${run.git.commit}\`${run.git.dirty ? ' (uncommitted changes)' : ''}, ` +
  `started ${run.started_at}, API cores ${run.api_cpus}, k6 cores ${run.k6_cpus}` +
  `${run.k6_args.length > 0 ? `, k6 args \`${run.k6_args.join(' ')}\`` : ''}`;

const renderMarkdown = ({ beforeDir, afterDir, before, after, comparison }) =>
  [
    `# Load test comparison: ${before.label ?? beforeDir} → ${after.label ?? afterDir}`,
    [runLine('Before', beforeDir, before), runLine('After', afterDir, after)].join('\n'),
    '## Comparability',
    comparison.problems.length === 0
      ? 'The runs are comparable: the same script, workload, k6 args and core split, and both ran to completion.'
      : "**The runs aren't fully comparable**, so treat the changes below with care:\n\n" +
        comparison.problems.map((problem) => `- ${problem}`).join('\n'),
    '## Summary',
    renderSummary(comparison),
    '## How changes are judged',
    `Each measure has a noise allowance calibrated on back-to-back runs of the same code: ${NOISE_CALIBRATION} ` +
      'A change bigger than its allowance is **higher** or **lower**; "no clear change" isn\'t proof of no change. ' +
      'CPU per iteration and latency are over the steps both runs passed cleanly (status ok in both); latency ' +
      `also leaves out steps where either run's k6 was at ${K6_BUSY_RATIO * 100}% or more of its CPU limit ` +
      `(${comparison.latency.leftOut} left out here), since a busy k6 inflates measured latency. ` +
      'A run that didn\'t find the limit only bounds it from below, so a limit change against it is ' +
      'unresolved unless it holds against that bound.',
    '## By step',
    'Before / after for each step.',
    renderSteps(before, after),
  ].join('\n\n') + '\n';

// --- Effects ----------------------------------------------------------------

const readRun = (runDir) => {
  const path = join(runDir, 'run.json');
  const parsed = RunSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    console.error(
      `${path} isn't a breaking-point run in the expected format (older runs predate per-step results):\n` +
        z.prettifyError(parsed.error)
    );
    process.exit(2);
  }
  return parsed.data;
};

const main = (beforeDir, afterDir) => {
  if (beforeDir === undefined || afterDir === undefined) {
    console.error('Usage: node test/load-test/scripts/compare.mjs <before-run-dir> <after-run-dir>');
    process.exit(2);
  }
  const before = readRun(beforeDir);
  const after = readRun(afterDir);
  const comparison = compareRuns(before, after);
  const outPath = join(afterDir, 'comparison.md');
  writeFileSync(
    outPath,
    renderMarkdown({
      beforeDir: basename(resolve(beforeDir)),
      afterDir: basename(resolve(afterDir)),
      before,
      after,
      comparison,
    })
  );
  comparison.problems.forEach((problem) => console.error(`[compare] ${problem}`));
  console.log(outPath);
  process.exit(comparison.problems.length === 0 ? 0 : 1);
};

main(process.argv[2], process.argv[3]);
