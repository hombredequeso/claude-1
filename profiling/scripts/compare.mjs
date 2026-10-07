// Compares two run directories written by profiling/run.sh, from the
// summary.json in each, and writes comparison.md into the after run's
// directory: how each area, file, package, module and function's share of
// busy time changed between the runs, and whether each change is bigger than
// sampling noise.
//
// Usage: node profiling/scripts/compare.mjs <before-run-dir> <after-run-dir>
//
// Shares of busy time are compared rather than milliseconds: CPU time per
// request varies ±20–40% between identical runs (CPU frequency scaling,
// machine load), while shares are much more stable. A share is estimated
// from samples, so it carries sampling noise: with N busy samples, a share p
// has a standard error of sqrt(p(1 - p) / N). Back-to-back runs of the same
// code vary more than sampling alone explains, though: across the three
// noise-* runs in profiling/reports (20,000 iterations each), differences
// were typically 1.5 standard errors, and the biggest was 4.3. So a change
// counts as clear only when it is more than NOISE_SIGMAS standard errors of
// the difference. Rows with fewer than MIN_SAMPLES samples in both runs are
// too small to judge.
//
// summary.json lists only the top functions by self and total time, so a
// function missing from one run is known only to be below the smallest figure
// listed there. It's shown as "< x%", and a change is only called clear if it
// holds against that bound; a row whose bound is no lower than the other
// run's figure says nothing, and is left out. Functions are matched by name and location, then,
// for those left over, by name and file, so a function whose line moved
// between the runs still matches.
//
// Also checks the runs are comparable: the same iterations, k6 args, sample
// interval and request mix, and no failed requests. The mix is random (each
// iteration picks its request at random, unseeded), so each request type's
// share of all requests is only checked to be within chance of the other's.
//
// Exits 0 if the comparison was written and the runs are comparable, 1 if it
// was written but they aren't (comparison.md says why), 2 if it couldn't be
// made. The last line printed is the path of comparison.md.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';

const NOISE_SIGMAS = 5;
const MIN_SAMPLES = 20;
// How many standard errors a request type's share of all requests can differ
// by between the runs before the request mix counts as different. The mix
// varies by chance alone, with no run-to-run effects on top, so 3 is enough.
const REQUEST_MIX_SIGMAS = 3;

const TimeSchema = z.object({ time_ms: z.number() });

const GroupSchema = z.object({ group: z.string(), time_ms: z.number() });

const FunctionSchema = z.object({
  function: z.string(),
  location: z.string().nullable(),
  area: z.string(),
  self: TimeSchema,
  total: TimeSchema,
});

const SummarySchema = z.object({
  run: z.object({
    label: z.string().nullable(),
    k6_args: z.array(z.string()),
    sample_interval_us: z.number(),
    started_at: z.string(),
    git: z.object({ commit: z.string(), dirty: z.boolean() }),
  }),
  load: z.object({
    iterations: z.number(),
    requests: z.number(),
    failed_requests: z.number(),
    busy_cpu_us_per_request: z.number().nullable(),
    by_request: z.array(z.object({ name: z.string(), count: z.number() })),
  }),
  profile: z.object({
    busy_ms: z.number(),
    areas: z.array(z.object({ area: z.string(), time_ms: z.number() })),
    app_files: z.array(GroupSchema),
    dependency_packages: z.array(GroupSchema),
    node_modules_internal: z.array(GroupSchema),
    functions_by_self_time: z.array(FunctionSchema),
    functions_by_total_time: z.array(FunctionSchema),
  }),
});

// --- Pure: comparison -------------------------------------------------------

// A row's time in one run: measured, or, for a function missing from the
// run's top lists, known only to be at most some bound.
const measured = (timeMs) => ({ kind: 'Measured', timeMs });
const atMost = (timeMs) => ({ kind: 'AtMost', timeMs });

// What a run's figures are relative to: its busy time and sample interval.
const sideOf = (summary) => ({
  busyMs: summary.profile.busy_ms,
  sampleMs: summary.run.sample_interval_us / 1000,
});

const samplesOf = (timeMs, side) => timeMs / side.sampleMs;
const shareOf = (timeMs, side) => (side.busyMs === 0 ? 0 : timeMs / side.busyMs);
const busySamples = (side) => Math.max(samplesOf(side.busyMs, side), 1);

const shareVariance = (share, side) => (share * (1 - share)) / busySamples(side);

// A bound overstates the time it stands for, so a change measured against a
// bound only holds if it points away from it: a drop to an "at most" after
// figure is at least as big as it looks, a drop from an "at most" before
// figure may not be a drop at all.
const verdictOf = (before, after, change, noise, sides) => {
  if (samplesOf(before.timeMs, sides.before) < MIN_SAMPLES && samplesOf(after.timeMs, sides.after) < MIN_SAMPLES) {
    return 'TooFewSamples';
  }
  if (Math.abs(change) <= noise) {
    return 'NoClearChange';
  }
  if (change < 0) {
    return before.kind === 'Measured' ? 'Lower' : 'NoClearChange';
  }
  return after.kind === 'Measured' ? 'Higher' : 'NoClearChange';
};

const compareRow = (label, before, after, sides) => {
  const beforeShare = shareOf(before.timeMs, sides.before);
  const afterShare = shareOf(after.timeMs, sides.after);
  const change = afterShare - beforeShare;
  const noise =
    NOISE_SIGMAS * Math.sqrt(shareVariance(beforeShare, sides.before) + shareVariance(afterShare, sides.after));
  return {
    label,
    before,
    after,
    beforeShare,
    afterShare,
    change,
    noise,
    verdict: verdictOf(before, after, change, noise, sides),
  };
};

const byLargerShare = (a, b) => Math.max(b.beforeShare, b.afterShare) - Math.max(a.beforeShare, a.afterShare);

// Rows for a breakdown that lists every group with any time, so a group
// missing from one run had none there.
const groupRows = (beforeGroups, afterGroups, sides) => {
  const beforeTimes = new Map(beforeGroups.map((group) => [group.group, group.time_ms]));
  const afterTimes = new Map(afterGroups.map((group) => [group.group, group.time_ms]));
  const names = new Set(Array.from(beforeTimes.keys()).concat(Array.from(afterTimes.keys())));
  return Array.from(names, (name) =>
    compareRow(`\`${name}\``, measured(beforeTimes.get(name) ?? 0), measured(afterTimes.get(name) ?? 0), sides)
  ).sort(byLargerShare);
};

const areaGroups = (profile) => profile.areas.map((area) => ({ group: area.area, time_ms: area.time_ms }));

const NATIVE = '(native)';

const functionKey = (entry) => `${entry.function}|${entry.location ?? NATIVE}|${entry.area}`;
const functionFileKey = (entry) => `${entry.function}|${(entry.location ?? NATIVE).replace(/:\d+$/, '')}|${entry.area}`;

// Every function a run's summary lists, by self or by total time.
const functionsOf = (profile) =>
  Array.from(
    new Map(
      profile.functions_by_self_time.concat(profile.functions_by_total_time).map((entry) => [functionKey(entry), entry])
    ).values()
  );

const smallest = (values) => (values.length === 0 ? 0 : Math.min(...values));

// The most self or total time a function missing from the run's lists can have.
const functionBounds = (profile) => ({
  self: smallest(profile.functions_by_self_time.map((entry) => entry.self.time_ms)),
  total: smallest(profile.functions_by_total_time.map((entry) => entry.total.time_ms)),
});

// Entries whose key is shared by no other entry in the same run, by key.
const uniqueByKey = (entries, keyOf) =>
  new Map(
    Array.from(Map.groupBy(entries, keyOf))
      .filter(([, group]) => group.length === 1)
      .map(([key, group]) => [key, group[0]])
  );

const matchBy = (keyOf, { pairs, before, after }) => {
  const beforeByKey = uniqueByKey(before, keyOf);
  const afterByKey = uniqueByKey(after, keyOf);
  const matched = Array.from(beforeByKey)
    .filter(([key]) => afterByKey.has(key))
    .map(([key, entry]) => ({ before: entry, after: afterByKey.get(key) }));
  const matchedBefore = new Set(matched.map((pair) => pair.before));
  const matchedAfter = new Set(matched.map((pair) => pair.after));
  return {
    pairs: pairs.concat(matched),
    before: before.filter((entry) => !matchedBefore.has(entry)),
    after: after.filter((entry) => !matchedAfter.has(entry)),
  };
};

// Each function paired with itself in the other run, or with null if the
// other run doesn't list it.
const pairFunctions = (before, after) => {
  const exact = matchBy(functionKey, { pairs: [], before, after });
  const { pairs, before: onlyBefore, after: onlyAfter } = matchBy(functionFileKey, exact);
  return pairs
    .concat(onlyBefore.map((entry) => ({ before: entry, after: null })))
    .concat(onlyAfter.map((entry) => ({ before: null, after: entry })));
};

const functionLabel = ({ before, after }) => {
  const name = (before ?? after).function;
  const beforeLocation = before?.location ?? NATIVE;
  const afterLocation = after?.location ?? NATIVE;
  const location = before !== null && after !== null && beforeLocation !== afterLocation
    ? `${beforeLocation}\` → \`${afterLocation}`
    : (before ?? after).location ?? NATIVE;
  return `\`${name}\` \`${location}\``;
};

// A bound no lower than the other run's figure says nothing about the change.
const boundIsInformative = (row) =>
  (row.before.kind === 'Measured' || row.beforeShare < row.afterShare) &&
  (row.after.kind === 'Measured' || row.afterShare < row.beforeShare);

const functionRows = (pairs, timeOf, bounds, sides) =>
  pairs
    .map((pair) =>
      compareRow(
        functionLabel(pair),
        pair.before === null ? atMost(bounds.before) : measured(timeOf(pair.before)),
        pair.after === null ? atMost(bounds.after) : measured(timeOf(pair.after)),
        sides
      )
    )
    .filter(boundIsInformative)
    .sort(byLargerShare);

// Whether a request type's share of all requests differs between the runs
// by more than chance.
const mixDiffers = (beforeCount, beforeTotal, afterCount, afterTotal) => {
  const beforeShare = beforeTotal === 0 ? 0 : beforeCount / beforeTotal;
  const afterShare = afterTotal === 0 ? 0 : afterCount / afterTotal;
  const variance =
    (beforeShare * (1 - beforeShare)) / Math.max(beforeTotal, 1) + (afterShare * (1 - afterShare)) / Math.max(afterTotal, 1);
  return Math.abs(afterShare - beforeShare) > REQUEST_MIX_SIGMAS * Math.sqrt(variance);
};

const requestMixProblems = (before, after) => {
  const beforeCounts = new Map(before.load.by_request.map((request) => [request.name, request.count]));
  const afterCounts = new Map(after.load.by_request.map((request) => [request.name, request.count]));
  const names = new Set(Array.from(beforeCounts.keys()).concat(Array.from(afterCounts.keys())));
  const share = (count, total) => formatShare(total === 0 ? 0 : count / total);
  return Array.from(names)
    .filter((name) =>
      mixDiffers(beforeCounts.get(name) ?? 0, before.load.requests, afterCounts.get(name) ?? 0, after.load.requests)
    )
    .map(
      (name) =>
        `The request mix differs: \`${name}\` was ${share(beforeCounts.get(name) ?? 0, before.load.requests)} of ` +
        `requests before, ${share(afterCounts.get(name) ?? 0, after.load.requests)} after.`
    );
};

const failureProblem = (summary, which) =>
  summary.load.failed_requests > 0
    ? `${summary.load.failed_requests} of ${summary.load.requests} requests failed in the ${which} run, ` +
      "so its profile isn't of normal behaviour."
    : null;

// Reasons the runs' shares can't be compared like for like.
const comparabilityProblems = (before, after) =>
  [
    before.load.iterations === after.load.iterations
      ? null
      : `Iterations differ: ${before.load.iterations} before, ${after.load.iterations} after. The store grows to a ` +
        "different size, so anything that scales with it (e.g. listing) isn't comparable.",
    before.run.k6_args.join(' ') === after.run.k6_args.join(' ')
      ? null
      : `k6 args differ: \`${before.run.k6_args.join(' ') || '(none)'}\` before, ` +
        `\`${after.run.k6_args.join(' ') || '(none)'}\` after.`,
    before.run.sample_interval_us === after.run.sample_interval_us
      ? null
      : `Sample intervals differ: ${before.run.sample_interval_us} µs before, ${after.run.sample_interval_us} µs after.`,
    failureProblem(before, 'before'),
    failureProblem(after, 'after'),
    Date.parse(before.run.started_at) <= Date.parse(after.run.started_at)
      ? null
      : 'The after run started before the before run: check the order of the arguments.',
  ]
    .filter((problem) => problem !== null)
    .concat(requestMixProblems(before, after));

const compareSummaries = (before, after) => {
  const sides = { before: sideOf(before), after: sideOf(after) };
  const pairs = pairFunctions(functionsOf(before.profile), functionsOf(after.profile));
  const appPairs = pairs.filter((pair) => (pair.before ?? pair.after).area === 'app');
  const beforeBounds = functionBounds(before.profile);
  const afterBounds = functionBounds(after.profile);
  const selfBounds = { before: beforeBounds.self, after: afterBounds.self };
  const totalBounds = { before: beforeBounds.total, after: afterBounds.total };
  const selfOf = (entry) => entry.self.time_ms;
  const totalOf = (entry) => entry.total.time_ms;
  return {
    problems: comparabilityProblems(before, after),
    areas: groupRows(areaGroups(before.profile), areaGroups(after.profile), sides),
    appFiles: groupRows(before.profile.app_files, after.profile.app_files, sides),
    packages: groupRows(before.profile.dependency_packages, after.profile.dependency_packages, sides),
    nodeModules: groupRows(before.profile.node_modules_internal, after.profile.node_modules_internal, sides),
    functionsSelf: functionRows(pairs, selfOf, selfBounds, sides),
    appFunctionsSelf: functionRows(appPairs, selfOf, selfBounds, sides),
    appFunctionsTotal: functionRows(appPairs, totalOf, totalBounds, sides),
  };
};

// --- Pure: rendering --------------------------------------------------------

const table = (headers, rows) =>
  [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`]
    .concat(rows.map((row) => `| ${row.join(' | ')} |`))
    .join('\n');

const formatShare = (share) => `${(share * 100).toFixed(1)}%`;

const measureCell = (measure, share) => {
  switch (measure.kind) {
    case 'Measured':
      return `${formatShare(share)} (${measure.timeMs.toFixed(1)} ms)`;
    case 'AtMost':
      return `< ${formatShare(share)} (not listed)`;
    default:
      throw measure;
  }
};

const changeCell = (change) => `${change >= 0 ? '+' : '−'}${Math.abs(change * 100).toFixed(1)} pts`;

const verdictCell = (verdict) => {
  switch (verdict) {
    case 'Lower':
      return '**lower**';
    case 'Higher':
      return '**higher**';
    case 'NoClearChange':
      return 'no clear change';
    case 'TooFewSamples':
      return 'too few samples';
    default:
      throw verdict;
  }
};

const ROW_HEADERS = ['Before', 'After', 'Change', 'Noise (±)', 'Verdict'];

const rowCells = (row) => [
  measureCell(row.before, row.beforeShare),
  measureCell(row.after, row.afterShare),
  changeCell(row.change),
  `${(row.noise * 100).toFixed(1)} pts`,
  verdictCell(row.verdict),
];

const renderRows = (rows) =>
  rows.length === 0 ? '(none)' : table([''].concat(ROW_HEADERS), rows.map((row) => [row.label].concat(rowCells(row))));

const isClear = (row) => row.verdict === 'Lower' || row.verdict === 'Higher';

const labelled = (kind, rows) => rows.map((row) => ({ kind, row }));

const renderClearChanges = (comparison) => {
  const clear = labelled('area', comparison.areas)
    .concat(labelled('file', comparison.appFiles))
    .concat(labelled('package', comparison.packages))
    .concat(labelled('module', comparison.nodeModules))
    .concat(labelled('function, self', comparison.functionsSelf))
    .concat(labelled('function, total', comparison.appFunctionsTotal))
    .filter((entry) => isClear(entry.row))
    .sort((a, b) => Math.abs(b.row.change) - Math.abs(a.row.change));
  return clear.length === 0
    ? 'None: no share of busy time changed by more than sampling noise.'
    : table(
        ['', 'What'].concat(ROW_HEADERS),
        clear.map((entry) => [entry.row.label, entry.kind].concat(rowCells(entry.row)))
      );
};

const runLine = (which, dir, summary) =>
  `- **${which}**: \`${dir}\`, commit \`${summary.run.git.commit}\`` +
  `${summary.run.git.dirty ? ' (uncommitted changes)' : ''}, started ${summary.run.started_at}` +
  `${summary.run.k6_args.length > 0 ? `, k6 args \`${summary.run.k6_args.join(' ')}\`` : ''}`;

const percentChange = (before, after) =>
  before === null || after === null || before === 0
    ? ''
    : `${after >= before ? '+' : '−'}${Math.abs(((after - before) / before) * 100).toFixed(0)}%`;

const renderLoad = (before, after) =>
  table(
    ['', 'Before', 'After', 'Change'],
    [
      ['Iterations', before.load.iterations, after.load.iterations, ''],
      ['Requests', before.load.requests, after.load.requests, ''],
      ['Failed requests', before.load.failed_requests, after.load.failed_requests, ''],
      ['Busy ms', before.profile.busy_ms, after.profile.busy_ms, percentChange(before.profile.busy_ms, after.profile.busy_ms)],
      [
        'CPU µs per request',
        before.load.busy_cpu_us_per_request ?? '',
        after.load.busy_cpu_us_per_request ?? '',
        percentChange(before.load.busy_cpu_us_per_request, after.load.busy_cpu_us_per_request),
      ],
    ]
  );

const renderMarkdown = ({ beforeDir, afterDir, before, after, comparison }) =>
  [
    `# CPU profile comparison: ${before.run.label ?? beforeDir} → ${after.run.label ?? afterDir}`,
    [runLine('Before', beforeDir, before), runLine('After', afterDir, after)].join('\n'),
    '## Comparability',
    comparison.problems.length === 0
      ? 'The runs are comparable: the same iterations, k6 args, sample interval and request mix, and no failed requests.'
      : "**The runs aren't fully comparable**, so treat the changes below with care:\n\n" +
        comparison.problems.map((problem) => `- ${problem}`).join('\n'),
    '## Load',
    renderLoad(before, after),
    'CPU µs per request varies ±20–40% between identical runs, so a change in it alone, from one run each, ' +
      "isn't evidence of anything. Compare shares of busy time, below.",
    '## How changes are judged',
    'Figures are shares of busy time, with milliseconds in brackets. **Noise** is ' +
      `${NOISE_SIGMAS} standard errors of the difference from sampling, which allows for back-to-back runs ` +
      'of the same code varying more than sampling alone explains; a change bigger than that is ' +
      `**lower** or **higher**. Rows with fewer than ${MIN_SAMPLES} samples in both runs are too few to judge. ` +
      '"Not listed" means the function wasn\'t in that run\'s top functions, so its figure is at most the ' +
      "one shown; where that bound is no lower than the other run's figure, the row is left out. " +
      '"No clear change" isn\'t proof of no change: a longer run (more samples) can resolve smaller ones.',
    '## Clear changes',
    'Every area, file, package, module and function whose share of busy time changed by more than noise, ' +
      'biggest change first. Functions by total time are the API\'s own only.',
    renderClearChanges(comparison),
    '## By area',
    renderRows(comparison.areas),
    "## The API's own code, by file",
    renderRows(comparison.appFiles),
    "## The API's own functions, by self time",
    renderRows(comparison.appFunctionsSelf),
    "## The API's own functions, by total time",
    renderRows(comparison.appFunctionsTotal),
    `Dependencies (${comparison.packages.length} packages), node's internals ` +
      `(${comparison.nodeModules.length} modules) and all listed functions ` +
      `(${comparison.functionsSelf.length}) were compared too; only their clear changes are shown, above.`,
  ].join('\n\n') + '\n';

// --- Effects ----------------------------------------------------------------

const readSummary = (runDir) => {
  const path = join(runDir, 'summary.json');
  const parsed = SummarySchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    console.error(`${path} isn't in the expected format:\n${z.prettifyError(parsed.error)}`);
    process.exit(2);
  }
  return parsed.data;
};

const main = (beforeDir, afterDir) => {
  if (beforeDir === undefined || afterDir === undefined) {
    console.error('Usage: node profiling/scripts/compare.mjs <before-run-dir> <after-run-dir>');
    process.exit(2);
  }
  const before = readSummary(beforeDir);
  const after = readSummary(afterDir);
  const comparison = compareSummaries(before, after);
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
