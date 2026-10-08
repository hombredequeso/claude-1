---
name: profile
description: Profile the API's CPU use under its representative request mix and diagnose where the time goes — which of the API's own code, and which dependency or builtin work it triggers, is worth optimising, with source file:line locations. Diagnosis only; it doesn't change code. Also compares two runs, to check whether a change fixed a hot spot. Use when asked to profile the API, find CPU hot spots, explain why the API is slow or CPU-heavy, or confirm that an optimisation worked.
allowed-tools: Bash(profiling/run.sh:*), Bash(SKIP_BUILD=1 profiling/run.sh:*), Bash(node profiling/scripts/compare.mjs:*), Read, Grep, Glob
---

# Profile

Runs `profiling/run.sh`, which builds the API, runs it under node's CPU profiler while k6 drives
a fixed amount of the project's workload through it, and writes a report directory whose
`summary.md` says where the CPU time went. Then reads the summary and the
code it points at, and reports what is worth optimising. In compare mode, profiles again (or takes
a second report) and reports whether a change made a difference, from
`profiling/scripts/compare.mjs`.

**Diagnose only.** Don't edit code, even for an obvious fix: report findings and suggestions, and
leave the decision to the user.

How to build, start and drive the API comes from the project manifest, `.claude/diagnostics.json`
(documented in `scripts/diagnostics-manifest.mjs`): the workload is the k6 module it names. If
`run.sh` reports a missing or invalid manifest, report that and stop. Below, `src/` means the
manifest's `sourceRoot`.

## Usage

```
/profile                          # run a fresh profile, default settings
/profile <focus>                  # e.g. "listing orders": run, then focus the diagnosis there
/profile <report-dir>             # diagnose an existing profiling/reports/<dir>, without re-running
/profile -- <k6 args>             # pass k6 args through, e.g. -- -e ITERATIONS=50000
/profile compare <before> [<after>] [<focus>]
                                  # compare a run with a fresh run (or an existing <after>
                                  # report), e.g. to check a fix; see "Comparing runs"
```

If the first argument is `compare`, follow [Comparing runs](#comparing-runs) instead of the steps
below.

## Steps

### 1. Get a report

If the arguments name an existing directory under `profiling/reports/`, use it and skip to step 2.

Otherwise run, in the foreground (a run takes about 10–20 s):

```
profiling/run.sh <label> [-- <k6 args>]
```

`<label>` is a short kebab-case name for the run (e.g. the focus, or `diagnose`). The last line
of output is the report directory. Act on the exit code:

- **0**: go on.
- **1**: k6 errored or some requests failed. Read `k6-console.txt` and `api.log` in the report
  directory. If more than about 1% of requests failed, the profile isn't of normal behaviour:
  report the failures and stop. Otherwise go on, and mention it.
- **2**: the run couldn't be set up (port in use, build failed, API wouldn't start, no profile
  written). Report the message and the relevant log, and stop. Don't retry with changed settings
  unless the fix is obvious and harmless (e.g. `PORT=3101` when 3100 is taken).

### 2. Read the summary

Read `<report-dir>/summary.md` in full. It has, in order: the load (requests by type, CPU µs per
request), time by area, the API's own code by file, dependencies by package, node's internals by
module, functions by self and total time, hot lines in the API's own code (with the source line),
and the call stacks behind the ten hottest functions. Locations in the API's own code are
`src/*.ts` lines. `summary.json` has the same data; the raw `api.cpuprofile` is rarely needed.

Note the run's commit and whether it had uncommitted changes, in case the code has moved on.

### 3. Work out what is actionable

The bulk of busy time is usually a fixed per-request cost the API's code doesn't control: the
HTTP framework and its helpers (for this project, Koa: koa, koa-compose, delegates, @koa/router,
on-finished, mime-types, ...) and node's HTTP and stream internals together are typically ~70%,
and native `writev` (writing responses to the socket) alone ~12–15%. Don't report these as findings. Mention them only as the baseline, or if
something in them is out of line with that.

What is actionable is time the API's own code spends or causes:

- **Self time in `src/`**: the "by file" table, `app` rows in the function tables, and the hot
  lines. Open each significant location and read enough around it to understand what it does
  and how often it runs.
- **Dependency or builtin time triggered by `src/`**: a hot function in zod, JSON, Map/Array
  builtins, etc. whose call stacks pass through `src/` frames. The nearest `src/` frame in the
  stack is where the cost is caused. Look at the "Total" columns too: a `src/` function with a
  large total but small self time is expensive because of what it calls.
- **Signals in the area table**: GC above ~5% suggests allocation pressure (look for copying,
  intermediate arrays, per-request object churn); `vm` well above ~6% can mean deoptimisation or
  repeated compilation.

Weigh each candidate by how much busy time it accounts for **and** how often its code path runs:
the request table gives the mix (the workload module's header usually describes it too). Also
consider how the cost scales: if the workload creates records, the store grows during a run, so
anything that grows with the number of records (e.g. listing, paging offsets) matters more than
its share here.

### 4. Judge how sure each finding is

- Sampling is every 1 ms, so a figure of N ms is roughly N samples. Under ~20 ms (~20 samples),
  treat it as noise; don't build a finding on it alone.
- Hot lines split a function's time across its lines by sample counts, so lines with few samples
  are rough. Prefer function-level figures when they disagree.
- **CPU µs per request varies ±20–40% between identical runs** (CPU frequency scaling, machine
  load). Don't call a difference between runs a regression or improvement on one run each;
  compare shares of busy time, which are much more stable.
- If the API's own code is too small a share to say anything confident, suggest a longer run
  (`/profile -- -e ITERATIONS=50000`) rather than guessing.
- A CPU profile shows CPU only. It can't show time spent waiting, and says nothing about latency
  under concurrency (that's what `load-tests/` is for).

If nothing in the API's own code is worth changing, say so plainly. Don't invent findings to
fill the report.

### 5. Report

```
## CPU profile: <report dir>

<commit> (uncommitted changes, if so) · <iterations> iterations, <requests> requests, <failed>
failed · <µs> µs CPU/request (varies ±20–40% between runs) · startup <ms> ms CPU, excluded

### Where the time goes
- 3–5 bullets: the baseline (framework + HTTP + socket writes), the API's own share, anything
  notable in GC/vm.

### Findings
Ranked by the CPU they could save, most first. For each:

**<n>. <short title>** (`src/...ts:<line>`)
- Evidence: <ms and % of busy, self/total, which request types reach it>
- Why: <what the code does that costs this, from reading it>
- Suggestion: <the change, and roughly what it could save as a share of busy time>
- Confidence: high / medium / low, and why

### Not worth pursuing
- Brief notes on things that look hot but aren't actionable or are below the noise floor.

### Next steps
- e.g. a longer run for more samples, or which finding to try first and how to check it
  (after the change, `/profile compare <this report dir>`).
```

Keep the report concise. Cite `src/*.ts:line` for every finding.

## Comparing runs

`/profile compare <before> [<after>] [<focus>]`: whether a change, usually a fix for a finding in
`<before>`, made a difference. Diagnose only here too: don't edit code.

### C1. Get the two reports

`<before>` (and `<after>`, if given) name directories under `profiling/reports/`: a full name, or
an unambiguous part of one such as its label. If one matches nothing or several, list the
candidates and stop.

If there's no `<after>`, profile the current code with **the same k6 args as `<before>`** (its
`run.json` has them as `k6_args`), so the runs are comparable:

```
profiling/run.sh <label> [-- <before's k6 args>]
```

`<label>` is e.g. `after-<focus>` or `after-<before's label>`. Act on the exit code as in step 1.
Don't add or change k6 args for the after run alone: if the user wants a longer run, both runs
need it, and `<before>`'s code may no longer be checked out. Say so, and leave making a longer
before run to the user.

### C2. Compare

```
node profiling/scripts/compare.mjs <before-dir> <after-dir>
```

It writes `<after-dir>/comparison.md` (the last line printed) and exits:

- **0**: the runs are comparable; go on.
- **1**: written, but the runs aren't fully comparable (different iterations or k6 args, failed
  requests, a different request mix, or the arguments in the wrong order); the reasons are
  printed and at the top of `comparison.md`. Different iterations or more than ~1% failed requests
  make the comparison unreliable: report that and stop, unless the user asked for it anyway.
  Otherwise go on, and mention it.
- **2**: it couldn't be made (a missing or malformed `summary.json`). Report the message and stop.

### C3. Read the comparison and the change

Read `comparison.md` in full. It compares **shares of busy time**, not milliseconds, and gives
each row a verdict: **lower** or **higher** when the change is bigger than the noise column,
**no clear change**, or **too few samples**. The noise allowance is wider than sampling alone,
calibrated on back-to-back runs of the same code, so a clear change is a real one.

Work out what the change was meant to affect: the `<focus>` argument, else the findings in
`<before>`'s `summary.md` (its hottest `src/` rows), else ask. Then:

- See what changed in the code: `git diff` / `git log` between the runs' commits (both in
  `comparison.md`); if either run had uncommitted changes, the diff alone may not show the
  before code, so say what you can and can't tell.
- Find the rows for the target: its function (self and total), its file, and, for builtin or
  dependency work it caused (e.g. `Array.from`, zod), those rows too. A function renamed or
  moved is matched by name and file; a row only in one run shows `< x% (not listed)` on the other
  side, which is an upper bound.
- Look at the other clear changes: a fix can move cost elsewhere (a new hot spot, more GC).
- Ignore CPU µs per request as evidence; it varies ±20–40% between identical runs.

How to read the target's verdict:

- **lower**: the change worked, by about the change in points of busy time.
- **no clear change** with the shares moving the right way: not proven. If the target was a
  small share (a few % or less) of a short run, the run is too short to resolve it; suggest
  re-running both before and after code with more iterations (`-- -e ITERATIONS=50000`). Costs
  that grow with the store (listing, paging) show more clearly in a longer run too.
- **no clear change** with the shares barely moving, or **higher**: the change didn't help, or
  made it worse; read the code to see why.

### C4. Report

```
## CPU profile comparison: <before dir> → <after dir>

<before commit> → <after commit> (uncommitted changes, if so) · <iterations> iterations each ·
comparable / not comparable because <reasons>

### Verdict
<one or two sentences: fixed / improved / not shown / worse, and how sure>

### The target
- <row>: <before share> → <after share> (<change> pts, noise ±<noise>), <verdict>
- Why: <what the code change did, from the diff, and why it moves these rows>

### Other changes
- Other clear changes, and whether they're expected; or "none beyond noise".

### Next steps
- e.g. a longer run pair, commit the fix, or the next finding to try.
```

Keep it short. Cite `src/*.ts:line` where it helps.

## Files

- `.claude/diagnostics.json`: the project manifest (build, start, readiness, source root,
  workload); `scripts/diagnostics-manifest.mjs` documents it and the workload contract.
- `profiling/run.sh`: runs a profile end to end; its header documents options and output.
- `profiling/profile.k6.js`: the fixed-iteration k6 scenario (`ITERATIONS`, `VUS`, `SEED`), which
  runs the manifest's workload.
- `profiling/scripts/summarise.mjs`: turns the profile into `summary.md` and `summary.json`.
- `profiling/scripts/compare.mjs`: compares two runs' `summary.json` into `comparison.md`; its
  header documents how changes are judged.
