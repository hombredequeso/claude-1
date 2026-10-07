// Summarises a run directory written by profiling/run.sh: reads the API's CPU
// profile (api.cpuprofile), k6's summary and run.json, and writes
// summary.json and summary.md into the same directory.
//
// Usage: node profiling/scripts/summarise.mjs <run-dir>
//
// The profile is sampled: every SAMPLE_INTERVAL_US V8 records which function
// was running and the stack that called it. A sample's time is the gap to the
// next sample. From that, the summary gives:
//   - time by area: the API's own code, dependencies (by package), node's
//     internals, V8 builtins and native code, GC, and unattributed VM time
//   - the API's own code, by file
//   - functions by self time (time running the function itself) and by
//     total time (the function and everything it called; recursive calls
//     are counted once)
//   - for the heaviest functions by self time, the call stacks they were
//     most often reached through, so a hot builtin such as JSON.stringify
//     can be traced back to the code that called it
//   - the hottest lines in the API's own code, from V8's per-line sample
//     counts (positionTicks), with the line's source
//   - CPU time per request, the figure to compare between runs
// The API's own code is reported at its TypeScript source (src/*.ts), mapped
// through the source maps tsc writes next to dist/*.js; code without a source
// map is reported at its dist/ location. dist/ must still be the build that
// was profiled, which it is when run.sh runs this straight after the profile.
// Startup, before the API handles its first request, is reported as one
// figure and left out of the rest. Percentages are of busy time: the time
// from the first request to the end of the profile, less idle time.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { SourceMap } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const TOP_FUNCTIONS = 25;
const TOP_FUNCTIONS_WITH_STACKS = 10;
const STACKS_PER_FUNCTION = 3;
const MAX_STACK_FRAMES = 12;
const MAX_GROUP_ROWS = 15;
const TOP_LINES = 20;
const MAX_CODE_LENGTH = 100;

const PROJECT_ROOT = join(import.meta.dirname, '../..');

// V8's pseudo-functions, which have no script: where samples land when no
// JavaScript function is running.
const SPECIAL_AREAS = {
  '(root)': 'root',
  '(idle)': 'idle',
  '(garbage collector)': 'gc',
  '(program)': 'vm',
};

const AREA_DESCRIPTIONS = {
  app: "The API's own code (src/)",
  dependency: 'Dependencies (node_modules)',
  node: "Node's internals (node:*)",
  builtin: 'V8 builtins and native functions (JSON, RegExp, Array, ...)',
  gc: 'Garbage collection',
  vm: 'VM work not attributed to a JS function (compiling, IC misses, ...)',
  other: 'Other scripts',
};

const CallFrameSchema = z.object({
  functionName: z.string(),
  url: z.string(),
  lineNumber: z.number(),
  columnNumber: z.number(),
});

const ProfileSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.number(),
      callFrame: CallFrameSchema,
      children: z.array(z.number()).optional(),
      // Samples per line within the function, lines 1-based. Present on
      // nodes with samples.
      positionTicks: z.array(z.object({ line: z.number(), ticks: z.number() })).optional(),
    })
  ),
  startTime: z.number(),
  endTime: z.number(),
  samples: z.array(z.number()),
  timeDeltas: z.array(z.number()),
});

const K6MetricSchema = z.object({
  count: z.number().optional(),
  avg: z.number().optional(),
  'p(95)': z.number().optional(),
  passes: z.number().optional(),
});

const K6SummarySchema = z.object({
  metrics: z.record(z.string(), K6MetricSchema),
});

const RunSchema = z.object({
  label: z.string().nullable(),
  k6_args: z.array(z.string()),
  sample_interval_us: z.number(),
  started_at: z.string(),
  finished_at: z.string(),
  k6_exit_code: z.number(),
  git: z.object({ commit: z.string(), dirty: z.boolean() }),
});

// --- Pure: profile analysis -------------------------------------------------

const sum = (values) => values.reduce((total, value) => total + value, 0);

const sumBy = (items, keyOf, valueOf) =>
  new Map(
    Array.from(Map.groupBy(items, keyOf), ([key, group]) => [key, sum(group.map(valueOf))])
  );

const sortedDescending = (map) => Array.from(map).sort(([, a], [, b]) => b - a);

const frameKey = ({ functionName, url, lineNumber, columnNumber }) =>
  `${functionName}|${url}|${lineNumber}|${columnNumber}`;

const packageName = (pathInNodeModules) => {
  const parts = pathInNodeModules.split('/');
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
};

const scriptPath = (url) => (url.startsWith('file://') ? fileURLToPath(url) : url);

// Which area a frame's time belongs to, and the group within that area
// (package, file or module) it is reported under.
const classify = ({ functionName, url }) => {
  if (url === '') {
    const special = SPECIAL_AREAS[functionName];
    return special === undefined
      ? { area: 'builtin', group: '(V8 builtins and native)' }
      : { area: special, group: functionName };
  }
  if (url.startsWith('node:')) {
    return { area: 'node', group: url };
  }
  const path = scriptPath(url);
  const nodeModules = path.lastIndexOf('/node_modules/');
  if (nodeModules >= 0) {
    return { area: 'dependency', group: packageName(path.slice(nodeModules + '/node_modules/'.length)) };
  }
  if (path.startsWith(`${PROJECT_ROOT}/`)) {
    return { area: 'app', group: relative(PROJECT_ROOT, path) };
  }
  return { area: 'other', group: path };
};

// Where a position in a script came from in its source, via the script's
// source map: { path, line } (line 0-based), or null if it has no map or
// nothing maps there. `scripts` holds what loadScripts read for each of the
// API's own scripts.
const mapToSource = (scripts, url, line, column) => {
  const sourceMap = scripts.get(url)?.sourceMap ?? null;
  if (sourceMap === null) {
    return null;
  }
  const entry = sourceMap.findEntry(line, column);
  return entry.generatedLine === line && entry.originalSource !== undefined
    ? { path: resolve(dirname(scriptPath(url)), entry.originalSource), line: entry.originalLine }
    : null;
};

const location = (callFrame, scripts) => {
  const { url, lineNumber, columnNumber } = callFrame;
  if (url === '') {
    return null;
  }
  const source = mapToSource(scripts, url, lineNumber, columnNumber);
  if (source !== null) {
    return `${relative(PROJECT_ROOT, source.path)}:${source.line + 1}`;
  }
  const path = scriptPath(url);
  const nodeModules = path.lastIndexOf('/node_modules/');
  const shown = nodeModules >= 0
    ? path.slice(nodeModules + '/node_modules/'.length)
    : path.startsWith(`${PROJECT_ROOT}/`)
      ? relative(PROJECT_ROOT, path)
      : path;
  return `${shown}:${lineNumber + 1}`;
};

const describeFrame = (scripts) => (callFrame) => ({
  function: callFrame.functionName || '(anonymous)',
  location: location(callFrame, scripts),
  area: classify(callFrame).area,
});

// The file an app frame's time is reported under: its source file if mapped.
const appFile = (callFrame, scripts) => {
  const source = mapToSource(scripts, callFrame.url, callFrame.lineNumber, callFrame.columnNumber);
  return source === null ? classify(callFrame).group : relative(PROJECT_ROOT, source.path);
};

const isSpecial = (callFrame) => callFrame.url === '' && callFrame.functionName in SPECIAL_AREAS;

// A sample's time is the gap from it to the next sample. V8 occasionally
// records a small negative delta, which is treated as zero.
const sampleDurations = (timeDeltas) => timeDeltas.slice(1).concat([0]).map((delta) => Math.max(delta, 0));

const samplesWithDurations = (profile) => {
  const durations = sampleDurations(profile.timeDeltas);
  return profile.samples.map((nodeId, index) => ({ nodeId, duration: durations[index] }));
};

const selfTimeByNode = (samples) => sumBy(samples, (sample) => sample.nodeId, (sample) => sample.duration);

// Node's entry points for handling a connection and a request. Matching on
// the module alone isn't enough: loading node:_http_server and the like at
// startup runs code in them too.
const REQUEST_ENTRY_POINTS = new Set([
  'node:_http_server|connectionListener',
  'node:_http_common|parserOnHeadersComplete',
]);

// Nodes running inside node's HTTP server, i.e. handling a request.

const requestHandlingNodes = (nodesById, root) => {
  const found = new Set();
  const visit = (id, inServer) => {
    const node = nodesById.get(id);
    const handling = inServer || REQUEST_ENTRY_POINTS.has(`${node.callFrame.url}|${node.callFrame.functionName}`);
    if (handling) {
      found.add(id);
    }
    (node.children ?? []).forEach((child) => visit(child, handling));
  };
  visit(root, false);
  return found;
};

// The index of the first sample taken while handling a request. Everything
// before it is startup (loading modules, building the OpenAPI spec), which is
// reported as one figure and otherwise left out, so it doesn't dilute the
// picture of the work done per request.
const firstRequestSample = (samples, handlingNodes) => {
  const index = samples.findIndex((sample) => handlingNodes.has(sample.nodeId));
  return index === -1 ? samples.length : index;
};

const isIdle = (nodesById) => (sample) => classify(nodesById.get(sample.nodeId).callFrame).area === 'idle';

const parentByNode = (nodes) =>
  new Map(nodes.flatMap((node) => (node.children ?? []).map((child) => [child, node.id])));

const rootId = (nodes) => {
  const parents = parentByNode(nodes);
  return nodes.find((node) => !parents.has(node.id)).id;
};

// Time spent in each node and everything below it.
const subtreeTimes = (nodesById, selfTimes, root) => {
  const totals = new Map();
  const visit = (id) => {
    const total = (nodesById.get(id).children ?? []).reduce(
      (subtotal, child) => subtotal + visit(child),
      selfTimes.get(id) ?? 0
    );
    totals.set(id, total);
    return total;
  };
  visit(root);
  return totals;
};

// Total time per function. A function can appear more than once on a stack
// (recursion, or re-entry through callbacks); only its outermost appearance
// counts, so its time isn't counted twice.
const totalTimeByFunction = (nodesById, subtreeTotals, root) => {
  const totals = new Map();
  const visit = (id, keysOnPath) => {
    const node = nodesById.get(id);
    const key = frameKey(node.callFrame);
    const outermost = !keysOnPath.has(key);
    if (outermost) {
      totals.set(key, (totals.get(key) ?? 0) + subtreeTotals.get(id));
    }
    const childPath = outermost ? new Set(keysOnPath).add(key) : keysOnPath;
    (node.children ?? []).forEach((child) => visit(child, childPath));
  };
  visit(root, new Set());
  return totals;
};

// The frames from a node up to (not including) the root, leaf first.
const stackOf = (id, nodesById, parents) => {
  const node = nodesById.get(id);
  const parent = parents.get(id);
  return parent === undefined ? [] : [node.callFrame].concat(stackOf(parent, nodesById, parents));
};

const heaviestStacks = (key, nodes, nodesById, parents, selfTimes, busy, scripts) => {
  const stacks = nodes
    .filter((node) => frameKey(node.callFrame) === key && (selfTimes.get(node.id) ?? 0) > 0)
    .map((node) => ({ frames: stackOf(node.id, nodesById, parents).slice(1), time: selfTimes.get(node.id) }));
  const timeBySignature = sumBy(stacks, (stack) => stack.frames.map(frameKey).join('\n'), (stack) => stack.time);
  const framesBySignature = new Map(stacks.map((stack) => [stack.frames.map(frameKey).join('\n'), stack.frames]));
  return sortedDescending(timeBySignature)
    .slice(0, STACKS_PER_FUNCTION)
    .map(([signature, time]) => ({
      time_ms: toMs(time),
      percent_of_busy: percent(time, busy),
      callers: framesBySignature.get(signature).slice(0, MAX_STACK_FRAMES).map(describeFrame(scripts)),
      truncated: framesBySignature.get(signature).length > MAX_STACK_FRAMES,
    }));
};

const toMs = (microseconds) => Number((microseconds / 1000).toFixed(1));
const percent = (part, whole) => (whole === 0 ? 0 : Number(((part / whole) * 100).toFixed(1)));

const timeEntry = (time, busy) => ({ time_ms: toMs(time), percent_of_busy: percent(time, busy) });

const firstCodeColumn = (text) => Math.max(text.search(/\S/), 0);

const shortCode = (text) => {
  const trimmed = text.trim();
  return trimmed.length > MAX_CODE_LENGTH ? `${trimmed.slice(0, MAX_CODE_LENGTH)}...` : trimmed;
};

// Self time per line of the API's own code. V8 counts samples per line
// (positionTicks) over the whole profile, startup included; each node's self
// time from the load is split across its lines in proportion to those counts.
const hotLines = (nodes, selfTimes, scripts, busy) => {
  const lineTimes = nodes
    .filter((node) => scripts.has(node.callFrame.url) && (selfTimes.get(node.id) ?? 0) > 0)
    .flatMap((node) => {
      const positionTicks = node.positionTicks ?? [];
      const ticks = sum(positionTicks.map((position) => position.ticks));
      return positionTicks.map((position) => ({
        key: `${frameKey(node.callFrame)}|${position.line}`,
        callFrame: node.callFrame,
        line: position.line - 1,
        time: (selfTimes.get(node.id) * position.ticks) / ticks,
      }));
    });
  const lineByKey = new Map(lineTimes.map((lineTime) => [lineTime.key, lineTime]));
  return sortedDescending(sumBy(lineTimes, (lineTime) => lineTime.key, (lineTime) => lineTime.time))
    .slice(0, TOP_LINES)
    .map(([key, time]) => {
      const { callFrame, line } = lineByKey.get(key);
      const script = scripts.get(callFrame.url);
      const distCode = script.distLines[line] ?? '';
      const source = mapToSource(scripts, callFrame.url, line, firstCodeColumn(distCode));
      return {
        function: callFrame.functionName || '(anonymous)',
        location: source === null
          ? `${relative(PROJECT_ROOT, scriptPath(callFrame.url))}:${line + 1}`
          : `${relative(PROJECT_ROOT, source.path)}:${source.line + 1}`,
        code: shortCode(source === null ? distCode : (script.sourceLines.get(source.path)?.[source.line] ?? '')),
        time_ms: toMs(time),
        percent_of_busy: percent(time, busy),
      };
    });
};

const analyseProfile = (profile, scripts) => {
  const describe = describeFrame(scripts);
  const nodesById = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = parentByNode(profile.nodes);
  const root = rootId(profile.nodes);
  const allSamples = samplesWithDurations(profile);
  const loadStart = firstRequestSample(allSamples, requestHandlingNodes(nodesById, root));
  const startupSamples = allSamples.slice(0, loadStart);
  const loadSamples = allSamples.slice(loadStart);
  const startup = sum(startupSamples.filter((sample) => !isIdle(nodesById)(sample)).map((sample) => sample.duration));
  const selfTimes = selfTimeByNode(loadSamples);

  const frames = profile.nodes.map((node) => ({
    key: frameKey(node.callFrame),
    callFrame: node.callFrame,
    classification: classify(node.callFrame),
    self: selfTimes.get(node.id) ?? 0,
  }));
  const total = sum(frames.map((frame) => frame.self));
  const idle = sum(frames.filter((frame) => frame.classification.area === 'idle').map((frame) => frame.self));
  const busy = total - idle;

  const busyFrames = frames.filter((frame) => !['idle', 'root'].includes(frame.classification.area));
  const selfByArea = sumBy(busyFrames, (frame) => frame.classification.area, (frame) => frame.self);
  const groupTimes = (area) =>
    sortedDescending(
      sumBy(
        busyFrames.filter((frame) => frame.classification.area === area),
        (frame) => (area === 'app' ? appFile(frame.callFrame, scripts) : frame.classification.group),
        (frame) => frame.self
      )
    )
      .filter(([, time]) => time > 0)
      .map(([group, time]) => ({ group, time_ms: toMs(time), percent_of_busy: percent(time, busy) }));

  const functionFrames = frames.filter((frame) => !isSpecial(frame.callFrame));
  const callFrameByKey = new Map(functionFrames.map((frame) => [frame.key, frame.callFrame]));
  const selfByFunction = sumBy(functionFrames, (frame) => frame.key, (frame) => frame.self);
  const totalByFunction = totalTimeByFunction(nodesById, subtreeTimes(nodesById, selfTimes, root), root);

  const functionEntry = (key) => {
    const frame = describe(callFrameByKey.get(key));
    return {
      function: frame.function,
      location: frame.location,
      area: frame.area,
      self: timeEntry(selfByFunction.get(key) ?? 0, busy),
      total: timeEntry(totalByFunction.get(key) ?? 0, busy),
    };
  };
  const topBy = (times) =>
    sortedDescending(times)
      .filter(([key, time]) => callFrameByKey.has(key) && time > 0)
      .slice(0, TOP_FUNCTIONS)
      .map(([key]) => key);

  const topSelf = topBy(selfByFunction);
  return {
    startup_busy_ms: toMs(startup),
    load_ms: toMs(total),
    idle_ms: toMs(idle),
    busy_ms: toMs(busy),
    samples: loadSamples.length,
    areas: sortedDescending(selfByArea).map(([area, time]) => ({
      area,
      description: AREA_DESCRIPTIONS[area],
      time_ms: toMs(time),
      percent_of_busy: percent(time, busy),
    })),
    app_files: groupTimes('app'),
    dependency_packages: groupTimes('dependency'),
    node_modules_internal: groupTimes('node'),
    functions_by_self_time: topSelf.map(functionEntry),
    functions_by_total_time: topBy(totalByFunction).map(functionEntry),
    hot_function_stacks: topSelf.slice(0, TOP_FUNCTIONS_WITH_STACKS).map((key) => {
      const frame = describe(callFrameByKey.get(key));
      return {
        function: frame.function,
        location: frame.location,
        area: frame.area,
        stacks: heaviestStacks(key, profile.nodes, nodesById, parents, selfTimes, busy, scripts),
      };
    }),
    app_hot_lines: hotLines(profile.nodes, selfTimes, scripts, busy),
  };
};

// --- Pure: load summary -----------------------------------------------------

const REQUEST_METRIC = /^http_reqs\{name:(.+)\}$/;

const analyseLoad = (k6Summary, busyMs) => {
  const metrics = k6Summary.metrics;
  const requests = metrics.http_reqs?.count ?? 0;
  return {
    iterations: metrics.iterations?.count ?? 0,
    requests,
    failed_requests: metrics.http_req_failed?.passes ?? 0,
    busy_cpu_us_per_request: requests === 0 ? null : Number(((busyMs * 1000) / requests).toFixed(1)),
    by_request: Object.keys(metrics)
      .map((name) => name.match(REQUEST_METRIC))
      .filter((match) => match !== null)
      .map((match) => ({
        name: match[1],
        count: metrics[match[0]].count ?? 0,
        avg_duration_ms: Number((metrics[`http_req_duration{name:${match[1]}}`]?.avg ?? 0).toFixed(2)),
      }))
      .filter((request) => request.count > 0)
      .sort((a, b) => b.count - a.count),
  };
};

// --- Pure: rendering --------------------------------------------------------

const table = (headers, rows) =>
  [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`]
    .concat(rows.map((row) => `| ${row.join(' | ')} |`))
    .join('\n');

const timeCells = ({ time_ms, percent_of_busy }) => [`${time_ms}`, `${percent_of_busy}%`];

const functionName = (entry) => `\`${entry.function}\``;
const functionLocation = (entry) => (entry.location === null ? '(native)' : `\`${entry.location}\``);

const renderFunctions = (entries) =>
  table(
    ['Function', 'Location', 'Area', 'Self ms', 'Self %', 'Total ms', 'Total %'],
    entries.map((entry) =>
      [functionName(entry), functionLocation(entry), entry.area].concat(timeCells(entry.self), timeCells(entry.total))
    )
  );

const renderGroups = (entries) => {
  if (entries.length === 0) {
    return '(none)';
  }
  const shown = entries.slice(0, MAX_GROUP_ROWS);
  const rest = entries.slice(MAX_GROUP_ROWS);
  const restRow = rest.length === 0
    ? []
    : [
        [`(${rest.length} more)`].concat(
          timeCells({
            time_ms: toMs(sum(rest.map((entry) => entry.time_ms * 1000))),
            percent_of_busy: Number(sum(rest.map((entry) => entry.percent_of_busy)).toFixed(1)),
          })
        ),
      ];
  return table(['', 'Self ms', '% of busy'], shown.map((entry) => [`\`${entry.group}\``].concat(timeCells(entry))).concat(restRow));
};

const renderStack = (stack) =>
  [`- ${stack.time_ms} ms (${stack.percent_of_busy}%), ${stack.callers.length === 0 ? 'at the top of the stack' : 'called from:'}`]
    .concat(stack.callers.map((caller) => `    - ${functionName(caller)} ${functionLocation(caller)}`))
    .concat(stack.truncated ? ['    - ...'] : [])
    .join('\n');

// A pipe would end a table cell, even inside backticks.
const codeCell = (code) => (code === '' ? '' : `\`${code.replaceAll('|', '\\|')}\``);

const renderHotLines = (entries) =>
  entries.length === 0
    ? '(none)'
    : table(
        ['Location', 'Function', 'Self ms', '% of busy', 'Code'],
        entries.map((entry) =>
          [`\`${entry.location}\``, functionName(entry)].concat(timeCells(entry), [codeCell(entry.code)])
        )
      );

const renderHotStacks = (entries) =>
  entries
    .map((entry) => [`#### ${functionName(entry)} ${functionLocation(entry)}`].concat(entry.stacks.map(renderStack)).join('\n'))
    .join('\n\n');

const renderMarkdown = ({ run, load, profile }) =>
  [
    `# CPU profile${run.label ? `: ${run.label}` : ''}`,
    `Commit \`${run.git.commit}\`${run.git.dirty ? ' (uncommitted changes)' : ''}, ` +
      `load from ${run.started_at} to ${run.finished_at}` +
      `${run.k6_args.length > 0 ? `, k6 args \`${run.k6_args.join(' ')}\`` : ''}. ` +
      `Sampled every ${run.sample_interval_us} µs.`,
    '## Load',
    `${load.iterations} iterations, ${load.requests} requests, ${load.failed_requests} failed. ` +
      `**${load.busy_cpu_us_per_request} µs of busy API CPU per request** (busy time / requests), ` +
      'the figure to compare between runs.',
    table(['Request', 'Count', 'Avg ms'], load.by_request.map((request) => [request.name, request.count, request.avg_duration_ms])),
    '## Time',
    `From the first request to the end of the profile ${profile.load_ms} ms: ${profile.idle_ms} ms idle, ` +
      `**${profile.busy_ms} ms busy** (${profile.samples} samples). Percentages below are of busy time. ` +
      `Startup, before the first request, took ${profile.startup_busy_ms} ms of CPU and is left out of everything below.`,
    '### By area (self time)',
    table(['Area', 'Self ms', '% of busy', ''], profile.areas.map((area) => [area.area].concat(timeCells(area), [area.description]))),
    "### The API's own code, by file",
    renderGroups(profile.app_files),
    '### Dependencies, by package',
    renderGroups(profile.dependency_packages),
    "### Node's internals, by module",
    renderGroups(profile.node_modules_internal),
    '## Functions by self time',
    'Self: time running the function itself. Total: the function and everything it called.',
    renderFunctions(profile.functions_by_self_time),
    '## Functions by total time',
    renderFunctions(profile.functions_by_total_time),
    "## Hot lines in the API's own code",
    `The ${TOP_LINES} lines of the API's own code with the most self time. Time is split across a function's ` +
      'lines by sample counts, so lines with only a few samples are rough.',
    renderHotLines(profile.app_hot_lines),
    '## Where the hottest functions are called from',
    `For the top ${TOP_FUNCTIONS_WITH_STACKS} functions by self time, the ${STACKS_PER_FUNCTION} call stacks ` +
      'that account for most of their self time, nearest caller first.',
    renderHotStacks(profile.hot_function_stacks),
  ].join('\n\n') + '\n';

// --- Effects ----------------------------------------------------------------

const readJson = (schema, path) => {
  const parsed = schema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    console.error(`${path} isn't in the expected format:\n${z.prettifyError(parsed.error)}`);
    process.exit(1);
  }
  return parsed.data;
};

const readLines = (path) => readFileSync(path, 'utf8').split('\n');

// The API's own scripts, keyed by URL as the profile names them: each one's
// lines, its source map (null if it has none), and the lines of the sources
// the map points to.
const loadScripts = (profile) => {
  const urls = new Set(
    profile.nodes.map((node) => node.callFrame.url).filter((url) => classify({ functionName: '', url }).area === 'app')
  );
  return new Map(
    Array.from(urls, (url) => {
      const path = scriptPath(url);
      const mapPath = `${path}.map`;
      const sourceMap = existsSync(mapPath) ? new SourceMap(JSON.parse(readFileSync(mapPath, 'utf8'))) : null;
      const sourcePaths = (sourceMap?.payload.sources ?? []).map((source) => resolve(dirname(path), source));
      return [
        url,
        {
          distLines: readLines(path),
          sourceMap,
          sourceLines: new Map(sourcePaths.filter(existsSync).map((sourcePath) => [sourcePath, readLines(sourcePath)])),
        },
      ];
    })
  );
};

const main = (runDir) => {
  if (runDir === undefined) {
    console.error('Usage: node profiling/scripts/summarise.mjs <run-dir>');
    process.exit(2);
  }
  const run = readJson(RunSchema, join(runDir, 'run.json'));
  const cpuProfile = readJson(ProfileSchema, join(runDir, 'api.cpuprofile'));
  const profile = analyseProfile(cpuProfile, loadScripts(cpuProfile));
  const load = analyseLoad(readJson(K6SummarySchema, join(runDir, 'k6-summary.json')), profile.busy_ms);
  const summary = { run, load, profile };
  writeFileSync(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  writeFileSync(join(runDir, 'summary.md'), renderMarkdown(summary));
};

main(process.argv[2]);
