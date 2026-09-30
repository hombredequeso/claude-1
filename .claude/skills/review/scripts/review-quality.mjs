// Code-quality comparison for the /review skill. Runs this repo's quality checks against a base commit
// and against the code under review, all in parallel, and prints as JSON only what the change
// introduces: new lint/depcruise/knip/tsc/test problems, new functions over the complexity limit,
// changed functions whose complexity rose markedly, and files whose FTA score got worse.
//
// The checks mirror the package.json scripts (lint, depcruise, knip, complexity, complexity:functions)
// plus `tsc --noEmit` and `vitest run`. Both sides run with this checkout's installed tools, so a
// difference in results comes from the code, not from tool versions. The base (and --head, if given)
// is checked out into a temporary git worktree, so the working tree is never touched.
//
// Usage: node .claude/skills/review/scripts/review-quality.mjs [--base <ref>] [--head <ref>] [--path <path>]
//   --base  commit to compare against (default: merge-base of HEAD and its upstream, or main)
//   --head  commit under review (default: the working tree, including uncommitted and untracked files)
//   --path  only report results for this file or directory (relative to the cwd, or absolute)

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';

const COMPLEXITY_LIMIT = 8;
const MARKED_INCREASE_ABSOLUTE = 3;
const MARKED_INCREASE_RATIO = 0.5;
const FTA_WORSENING_RATIO = 0.1;
const FTA_BANDS = ['OK', 'Could be better', 'Needs improvement'];
const ERROR_OUTPUT_LINES = 20;

const execFileAsync = promisify(execFile);

// ---- process helpers (effectful) ----

const exec = async (command, args, cwd) => {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { cwd, maxBuffer: 256 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error) };
  }
};

const git = async (args, cwd) => {
  const result = await exec('git', args, cwd);
  return result.code === 0 ? result.stdout.trim() : null;
};

const tail = (text) => text.trim().split('\n').slice(-ERROR_OUTPUT_LINES).join('\n');

const toolError = (result) => ({
  kind: 'error',
  message: `exit code ${result.code}\n${tail(result.stderr || result.stdout)}`,
});

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// ---- checks: each collects the problems in one checkout ----

const issue = (file, id, line, text) => ({ file, id, line, text });

const lintIssues = (results, dir) =>
  results.flatMap((result) =>
    result.messages.map((message) =>
      issue(
        path.relative(dir, result.filePath),
        `${message.ruleId}|${message.message}`,
        message.line ?? null,
        `${message.severity === 2 ? 'error' : 'warning'} ${message.ruleId ?? '(parse)'}: ${message.message}`,
      ),
    ),
  );

const depcruiseIssues = (report) =>
  report.summary.violations.map((violation) =>
    issue(
      violation.from,
      `${violation.rule.name}|${violation.to}`,
      null,
      `${violation.rule.severity} ${violation.rule.name}: ${violation.from} -> ${violation.to}`,
    ),
  );

const IGNORED_KNIP_FIELDS = new Set(['file', 'owners']);

const knipItemName = (item) => (Array.isArray(item) ? item.map((member) => member.name).join(', ') : item.name);

const knipFieldItems = (value) => (Array.isArray(value) ? value : Object.values(value).flat());

const knipIssues = (report) =>
  report.issues.flatMap((entry) =>
    Object.entries(entry)
      .filter(([type, value]) => !IGNORED_KNIP_FIELDS.has(type) && value !== null && typeof value === 'object')
      .flatMap(([type, value]) =>
        knipFieldItems(value).map((item) =>
          issue(entry.file, `${type}|${knipItemName(item)}`, item.line ?? null, `unused/unlisted ${type}: ${knipItemName(item)}`),
        ),
      ),
  );

const TSC_FILE_ERROR = /^(.+)\((\d+),\d+\): error (TS\d+): (.*)$/;
const TSC_GLOBAL_ERROR = /^error (TS\d+): (.*)$/;

const tscLineIssue = (line) => {
  const fileMatch = TSC_FILE_ERROR.exec(line);
  if (fileMatch) {
    const [, file, lineNumber, code, message] = fileMatch;
    return issue(file, `${code}|${message}`, Number(lineNumber), `${code}: ${message}`);
  }
  const globalMatch = TSC_GLOBAL_ERROR.exec(line);
  return globalMatch ? issue('(config)', `${globalMatch[1]}|${globalMatch[2]}`, null, `${globalMatch[1]}: ${globalMatch[2]}`) : null;
};

const firstLine = (text) => (text ?? '').trim().split('\n')[0];

const testFileIssues = (testResult, dir) => {
  const file = path.relative(dir, testResult.name);
  const failures = testResult.assertionResults.filter((assertion) => assertion.status === 'failed');
  if (failures.length === 0 && testResult.status === 'failed') {
    return [issue(file, '(suite)', null, `test file failed: ${firstLine(testResult.message)}`)];
  }
  return failures.map((assertion) =>
    issue(file, assertion.fullName, null, `failed: ${assertion.fullName} — ${firstLine(assertion.failureMessages[0])}`),
  );
};

const collectJson = async (command, args, dir, toItems) => {
  const result = await exec(command, args, dir);
  const report = parseJson(result.stdout);
  return report === null ? toolError(result) : { kind: 'ok', items: toItems(report) };
};

const collectTsc = async (bin, dir) => {
  const result = await exec(bin('tsc'), ['--noEmit'], dir);
  const items = result.stdout.split('\n').map(tscLineIssue).filter((item) => item !== null);
  return result.code !== 0 && items.length === 0 ? toolError(result) : { kind: 'ok', items };
};

const collectTests = async (bin, dir, scratch, side) => {
  const outputFile = path.join(scratch, `vitest-${side}.json`);
  const result = await exec(bin('vitest'), ['run', '--reporter=json', `--outputFile=${outputFile}`], dir);
  const report = parseJson(await readFile(outputFile, 'utf8').catch(() => ''));
  return report === null
    ? toolError(result)
    : { kind: 'ok', items: report.testResults.flatMap((testResult) => testFileIssues(testResult, dir)) };
};

const ftaRow = (row) => ({ file: path.join('src', row.file_name), score: row.fta_score, assessment: row.assessment });

const complexityRow = (row) => ({ file: row.file, name: row.name, line: row.line, complexity: row.complexity });

const collectAll = (tools, side, dir, scratch) => {
  const { bin, formatter } = tools;
  return Promise.all([
    collectJson(bin('eslint'), ['.', '-f', 'json'], dir, (report) => lintIssues(report, dir)),
    collectJson(bin('depcruise'), ['src', '--output-type', 'json'], dir, depcruiseIssues),
    collectJson(bin('knip'), ['--reporter', 'json'], dir, knipIssues),
    collectTsc(bin, dir),
    collectTests(bin, dir, scratch, side),
    collectJson(bin('fta'), ['src', '--format', 'json'], dir, (rows) => rows.map(ftaRow)),
    collectJson(
      bin('eslint'),
      ['--rule', '{"complexity":["warn",{"max":0}]}', '-f', formatter, 'src'],
      dir,
      (rows) => rows.map(complexityRow),
    ),
  ]).then(([lint, depcruise, knip, typecheck, tests, fta, complexity]) => ({
    lint,
    depcruise,
    knip,
    typecheck,
    tests,
    fta,
    complexity,
  }));
};

// ---- line mapping: where a base line ends up in the head, from `git diff -U0` hunks (pure) ----

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_TARGET = /^\+\+\+ (?:b\/(.*)|\/dev\/null)$/;

const parseHunk = (match) => ({
  oldStart: Number(match[1]),
  oldCount: match[2] === undefined ? 1 : Number(match[2]),
  newStart: Number(match[3]),
  newCount: match[4] === undefined ? 1 : Number(match[4]),
});

// Hunks per head-side file path.
const parseLineMaps = (diff) =>
  new Map(
    diff
      .split(/^diff --git /m)
      .slice(1)
      .map((section) => {
        const lines = section.split('\n');
        const target = lines.map((line) => DIFF_TARGET.exec(line)).find((match) => match !== null);
        const hunks = lines.map((line) => HUNK_HEADER.exec(line)).filter((match) => match !== null).map(parseHunk);
        return [target?.[1] ?? null, hunks];
      })
      .filter(([file]) => file !== null),
  );

// How one hunk moves a base line: not at all (hunk is after it), by an offset (hunk is before it), or
// to the hunk's start (the line itself was changed or deleted). A hunk with oldCount 0 inserts lines
// after oldStart.
const hunkEffect = (hunk, line) => {
  if (hunk.oldCount === 0) {
    return line > hunk.oldStart ? { kind: 'Shift', by: hunk.newCount } : { kind: 'None' };
  }
  if (line < hunk.oldStart) {
    return { kind: 'None' };
  }
  return line < hunk.oldStart + hunk.oldCount
    ? { kind: 'Inside', at: hunk.newStart }
    : { kind: 'Shift', by: hunk.newCount - hunk.oldCount };
};

const mapLine = (hunks, line) => {
  const effects = hunks.map((hunk) => hunkEffect(hunk, line));
  const inside = effects.find((effect) => effect.kind === 'Inside');
  return inside === undefined
    ? line + effects.filter((effect) => effect.kind === 'Shift').reduce((total, effect) => total + effect.by, 0)
    : inside.at;
};

// ---- comparisons (pure) ----

const renamed = (renames) => (item) => {
  const file = renames.get(item.file) ?? item.file;
  return Object.assign({}, item, { file });
};

const issueKey = (item) => `${item.file}|${item.id}`;

const reportedIssue = (item, newCount, totalCount) => ({
  file: item.file,
  line: item.line,
  text: item.text,
  occurrences: newCount === totalCount ? null : `${newCount} new of ${totalCount} with this message in the file`,
});

const introducedIssues = (baseItems, headItems) => {
  const baseGroups = Map.groupBy(baseItems, issueKey);
  return Array.from(Map.groupBy(headItems, issueKey)).flatMap(([key, group]) => {
    const newCount = group.length - (baseGroups.get(key)?.length ?? 0);
    return newCount > 0 ? group.map((item) => reportedIssue(item, newCount, group.length)) : [];
  });
};

const isMarkedIncrease = (before, after) => {
  const delta = after - before;
  return (
    delta > 0 &&
    (delta >= MARKED_INCREASE_ABSOLUTE ||
      delta / before >= MARKED_INCREASE_RATIO ||
      (before <= COMPLEXITY_LIMIT && after > COMPLEXITY_LIMIT))
  );
};

const functionKey = (row) => `${row.file}|${row.name}`;

// Pairs same-named functions in one file: each base function's line is mapped through the diff to
// where it now sits, and pairs are taken closest-first; head functions left unpaired are new. Every
// base/head combination is scored, which is quadratic, but only within one name in one file (usually
// one or two functions).
const pairGroup = (baseGroup, headGroup, hunks) => {
  const candidates = baseGroup
    .flatMap((base) =>
      headGroup.map((head) => ({ base, head, distance: Math.abs(mapLine(hunks, base.line) - head.line) })),
    )
    .toSorted((a, b) => a.distance - b.distance);
  const chosen = candidates.reduce(
    (pairs, candidate) =>
      pairs.some((pair) => pair.base === candidate.base || pair.head === candidate.head) ? pairs : pairs.concat([candidate]),
    [],
  );
  return headGroup.map((head) => ({ base: chosen.find((pair) => pair.head === head)?.base ?? null, head }));
};

const pairFunctions = (baseRows, headRows, lineMaps) => {
  const baseGroups = Map.groupBy(baseRows, functionKey);
  return Array.from(Map.groupBy(headRows, functionKey)).flatMap(([key, group]) =>
    pairGroup(baseGroups.get(key) ?? [], group, lineMaps.get(group[0].file) ?? []),
  );
};

const functionReport = (pair) => ({
  file: pair.head.file,
  line: pair.head.line,
  name: pair.head.name,
  before: pair.base === null ? null : pair.base.complexity,
  after: pair.head.complexity,
});

const compareComplexity = (baseRows, headRows, context) => {
  const pairs = pairFunctions(baseRows, headRows, context.lineMaps);
  return {
    newFunctionsOverLimit: pairs
      .filter((pair) => pair.base === null && pair.head.complexity > COMPLEXITY_LIMIT)
      .map(functionReport),
    markedIncreases: pairs
      .filter((pair) => pair.base !== null && isMarkedIncrease(pair.base.complexity, pair.head.complexity))
      .map(functionReport),
  };
};

const bandIndex = (assessment) => FTA_BANDS.indexOf(assessment);

const roundScore = (score) => Math.round(score * 10) / 10;

const isFtaWorse = (base, head) =>
  base === null
    ? head.assessment !== 'OK'
    : bandIndex(head.assessment) > bandIndex(base.assessment) ||
      (head.score - base.score) / base.score >= FTA_WORSENING_RATIO;

const ftaSide = (row) => (row === null ? null : { score: roundScore(row.score), assessment: row.assessment });

const compareFta = (baseRows, headRows) => {
  const baseByFile = new Map(baseRows.map((row) => [row.file, row]));
  return {
    worsenedFiles: headRows
      .map((head) => ({ file: head.file, base: baseByFile.get(head.file) ?? null, head }))
      .filter((entry) => isFtaWorse(entry.base, entry.head))
      .map((entry) => ({ file: entry.file, before: ftaSide(entry.base), after: ftaSide(entry.head) })),
  };
};

const listIssues = (baseItems, headItems) => ({ introduced: introducedIssues(baseItems, headItems) });

const COMPARISONS = {
  lint: listIssues,
  depcruise: listIssues,
  knip: listIssues,
  typecheck: listIssues,
  tests: listIssues,
  complexity: compareComplexity,
  fta: compareFta,
};

// The filter is repo-relative ('' is the whole repo); it matches the path itself or anything inside
// it as a directory, so 'src/domain/order' doesn't match 'src/domain/order-archive'.
const underPath = (filter) => (entry) =>
  filter === null || filter === '' || entry.file === filter || entry.file.startsWith(`${filter}/`);

const filterReport = (report, keep) =>
  Object.fromEntries(Object.entries(report).map(([field, entries]) => [field, entries.filter(keep)]));

// If the base run failed (e.g. the base predates a tool's config), everything the head reports counts
// as introduced, and the result says the baseline was unavailable.
const compareCheck = (name, base, head, context) => {
  if (head.kind === 'error') {
    return { kind: 'error', message: head.message };
  }
  const baseItems = base.kind === 'ok' ? base.items.map(renamed(context.renames)) : [];
  const report = filterReport(COMPARISONS[name](baseItems, head.items, context), context.keep);
  return Object.assign({ kind: 'ok', baseline: base.kind === 'ok' ? 'ok' : `unavailable: ${base.message}` }, report);
};

// ---- git state (effectful) ----

const parseNameStatus = (line) => {
  const [status, first, second] = line.split('\t');
  return status.startsWith('R')
    ? { status: 'renamed', file: second, previousFile: first }
    : { status: { A: 'added', D: 'deleted', M: 'modified' }[status[0]] ?? status, file: first, previousFile: null };
};

const diffRange = (base, head) => (head === null ? [base] : [base, head]);

const changedFiles = async (root, base, head) => {
  const nameStatus = await git(['diff', '--name-status', '-M'].concat(diffRange(base, head)), root);
  const untracked = head === null ? await git(['ls-files', '--others', '--exclude-standard'], root) : '';
  const tracked = (nameStatus ?? '').split('\n').filter(Boolean).map(parseNameStatus);
  const added = (untracked ?? '')
    .split('\n')
    .filter(Boolean)
    .map((file) => ({ status: 'untracked', file, previousFile: null }));
  return tracked.concat(added);
};

const lineMapsFor = async (root, base, head) =>
  parseLineMaps((await git(['diff', '-U0', '-M'].concat(diffRange(base, head)), root)) ?? '');

const defaultBase = async (root) => {
  const upstream = (await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], root)) ?? 'main';
  return git(['merge-base', upstream, 'HEAD'], root);
};

const addWorktree = async (root, scratch, name, sha) => {
  const dir = path.join(scratch, name);
  const added = await exec('git', ['worktree', 'add', '--detach', dir, sha], root);
  if (added.code !== 0) {
    return { kind: 'error', message: tail(added.stderr) };
  }
  await symlink(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return { kind: 'ok', dir };
};

const removeWorktrees = async (root, dirs) => {
  await Promise.all(dirs.map((dir) => exec('git', ['worktree', 'remove', '--force', dir], root)));
  await exec('git', ['worktree', 'prune'], root);
};

// ---- main ----

const fail = (message) => {
  console.log(JSON.stringify({ kind: 'error', message }, null, 2));
  process.exitCode = 1;
};

const resolveRefs = async (root, args) => {
  const base = args.base === undefined ? await defaultBase(root) : await git(['rev-parse', '--verify', `${args.base}^{commit}`], root);
  const head = args.head === undefined ? null : await git(['rev-parse', '--verify', `${args.head}^{commit}`], root);
  if (base === null || (args.head !== undefined && head === null)) {
    return { kind: 'error', message: `could not resolve ${base === null ? 'base' : 'head'} commit` };
  }
  return { kind: 'ok', base, head };
};

const resolvePathFilter = (root, requested) => {
  if (requested === undefined) {
    return { kind: 'ok', filter: null };
  }
  const filter = path.relative(root, path.resolve(process.cwd(), requested));
  return filter.startsWith('..') || path.isAbsolute(filter)
    ? { kind: 'error', message: `--path ${requested} is outside the repository` }
    : { kind: 'ok', filter };
};

const prepareCheckouts = async (root, scratch, refs) => {
  const base = await addWorktree(root, scratch, 'base', refs.base);
  const head = refs.head === null ? { kind: 'ok', dir: root } : await addWorktree(root, scratch, 'head', refs.head);
  const created = [base, head].filter((checkout) => checkout.kind === 'ok' && checkout.dir !== root).map((checkout) => checkout.dir);
  const failed = [base, head].find((checkout) => checkout.kind === 'error');
  return failed === undefined
    ? { kind: 'ok', baseDir: base.dir, headDir: head.dir, created }
    : { kind: 'error', message: failed.message, created };
};

const compareAll = (baseResults, headResults, context) =>
  Object.fromEntries(
    Object.keys(COMPARISONS).map((name) => [name, compareCheck(name, baseResults[name], headResults[name], context)]),
  );

const review = async (root, scratch, filter, refs) => {
  const files = (await changedFiles(root, refs.base, refs.head)).filter(underPath(filter));
  const tools = {
    bin: (name) => path.join(root, 'node_modules', '.bin', name),
    formatter: path.join(root, 'scripts', 'complexity-formatter.js'),
  };
  const checkouts = await prepareCheckouts(root, scratch, refs);
  try {
    if (checkouts.kind === 'error') {
      return { kind: 'error', message: checkouts.message };
    }
    const [baseResults, headResults, lineMaps] = await Promise.all([
      collectAll(tools, 'base', checkouts.baseDir, scratch),
      collectAll(tools, 'head', checkouts.headDir, scratch),
      lineMapsFor(root, refs.base, refs.head),
    ]);
    const context = {
      renames: new Map(files.filter((file) => file.status === 'renamed').map((file) => [file.previousFile, file.file])),
      lineMaps,
      keep: underPath(filter),
    };
    return {
      kind: 'ok',
      base: refs.base,
      head: refs.head ?? 'working tree',
      pathFilter: filter,
      changedFiles: files,
      thresholds: {
        complexityLimit: `a function over ${COMPLEXITY_LIMIT} is over the limit`,
        markedIncrease: `+${MARKED_INCREASE_ABSOLUTE} or more, +${MARKED_INCREASE_RATIO * 100}% or more, or crossing the limit`,
        ftaWorsened: `score up ${FTA_WORSENING_RATIO * 100}% or more, a worse band, or a new file not rated OK`,
      },
      checks: compareAll(baseResults, headResults, context),
    };
  } finally {
    await removeWorktrees(root, checkouts.created);
  }
};

const main = async () => {
  const { values: args } = parseArgs({
    options: { base: { type: 'string' }, head: { type: 'string' }, path: { type: 'string' } },
  });
  const root = await git(['rev-parse', '--show-toplevel'], process.cwd());
  if (root === null) {
    return fail('not inside a git repository');
  }
  const refs = await resolveRefs(root, args);
  if (refs.kind === 'error') {
    return fail(refs.message);
  }
  const pathFilter = resolvePathFilter(root, args.path);
  if (pathFilter.kind === 'error') {
    return fail(pathFilter.message);
  }
  // Resolved, because tools report paths under the physical cwd (e.g. macOS /var -> /private/var), and
  // those must line up with the worktree paths they're made relative to.
  const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'review-quality-')));
  const result = await review(root, scratch, pathFilter.filter, refs);
  await rm(scratch, { recursive: true, force: true });
  return result.kind === 'error' ? fail(result.message) : console.log(JSON.stringify(result, null, 2));
};

await main();
