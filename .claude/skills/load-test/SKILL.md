---
name: load-test
description: Find the API's throughput limit under its representative request mix — the request rate at which latency or errors break down — and diagnose what limits it (the API's CPU, something else in the API, or the load generator), with latency and CPU headroom at each rate. Diagnosis only; it doesn't change code. Also compares two runs, to check whether a change raised the limit or cut the CPU cost per request. Use when asked to load test the API, find its maximum throughput or breaking point, check how it behaves under load, or confirm that a change improved throughput.
allowed-tools: Bash(test/load-test/run.sh:*), Bash(node test/load-test/scripts/compare.mjs:*), Bash(node test/load-test/scripts/run-result.mjs:*), Read, Grep, Glob
---

# Load test

Runs `test/load-test/run.sh` with `test/load-test/breaking-point.k6.js`, which builds the API,
starts a fresh copy of it, and has k6 step the request rate up (100 rps, then +250 rps every 30 s,
up to 5000) until a step's p95 latency or error rate fails, recording the API's and k6's CPU
throughout. The run's `run.json` says, step by step, what rate was achieved, the latency, and the
API main thread's and k6's CPU, and gives a verdict on whether the API's limit was found or k6 ran
out first. Then reads that and reports what limits throughput. In compare mode, runs again (or
takes a second report) and reports whether a change made a difference, from
`test/load-test/scripts/compare.mjs`.

**Diagnose only.** Don't edit code, even for an obvious fix: report findings and suggestions, and
leave the decision to the user.

How to build, start and drive the API comes from the project manifest, `.claude/diagnostics.json`
(documented in `scripts/diagnostics-manifest.mjs`): the workload is the k6 module it names. If
`run.sh` reports a missing or invalid manifest, report that, suggest `/diagnostics-init`, and stop.
Below, `src/` means the manifest's `sourceRoot`.

## Usage

```
/load-test                          # run a fresh breaking-point test, default settings
/load-test <focus>                  # e.g. "after the listing change": run, label it, focus there
/load-test <report-dir>             # diagnose an existing test/load-test/reports/<dir>, without re-running
/load-test -- <k6 args>             # pass k6 args through, e.g. -- -e STEP_RPS=100 -e MAX_RPS=3000
/load-test compare <before> [<after>] [<focus>]
                                    # compare a run with a fresh run (or an existing <after>
                                    # report), e.g. to check a fix; see "Comparing runs"
```

If the first argument is `compare`, follow [Comparing runs](#comparing-runs) instead of the steps
below.

## Steps

### 1. Get a report

If the arguments name an existing directory under `test/load-test/reports/`, use it and skip to
step 2. Its `run.json` must have a `breaking_point` section with per-step CPU
(`api_main_thread_cpu_pct`); older runs don't, so say what's missing and offer a fresh run.

Otherwise run:

```
test/load-test/run.sh test/load-test/breaking-point.k6.js <label> [-- <k6 args>]
```

`<label>` is a short kebab-case name for the run (e.g. the focus, or `diagnose`). A run stops at
the first failing step: with default settings that's up to 10 minutes, and about 5 on a 4-core
laptop, where k6 runs out of CPU around 2000–2500 rps. That can be longer than a foreground
command may run, so **run it in the background** and wait for the notification that it has
finished; don't poll. Tell the user it has started and roughly how long it will take. Don't run
anything else CPU-heavy meanwhile (builds, tests, another load test): the machine is shared with
the test, and that would distort it.

The last line of output names the report directory. Act on the exit code:

- **0** or **99**: go on. 99 only means a threshold was crossed, which is how a breaking-point
  run normally ends; `run.json`'s verdict says what it meant.
- **2**: the run couldn't be set up (port in use, build failed, API wouldn't start). Report the
  message and the relevant log (`build.log`, `api.log`), and stop. Don't retry with changed
  settings unless the fix is obvious and harmless (e.g. `PORT=3101` when 3100 is taken).
- **anything else**: k6 errored. Read `k6-console.txt`, report the error, and stop.

### 2. Read the result

Read `<report-dir>/run.json`. `breaking_point.verdict.result` is one of:

- **`api_limit_found`**: a step failed its p95 or error-rate threshold while k6 kept up. The API's
  limit is between `highest_passing_step_rps` and `failing_step_rps`. Check
  `at_failure.api_main_thread_saturated`: if true, the API was CPU-bound (its single JavaScript
  thread at ~100%); if false, it broke without being CPU-bound, so look for something else (see
  step 3) before taking the failing rate as the API's limit.
- **`k6_limit_reached`**: k6 ran out of CPU before the API broke: a step fell short of its target
  rate, or failed while k6 was saturated and the API wasn't. The API's limit is **above** the
  highest clean step, and this run can't say by how much. That's common on a small machine: the
  load generator needs more CPU per request than the API does.
- **`no_limit_found`**: every step passed at its full rate. The limit is above `MAX_RPS`.

Then go through `breaking_point.steps`. For each: `status` (`ok`, `api_failed`, `k6_shortfall`,
`not_reached`), `achieved_rps`, `p95_ms`, `median_ms`, `failed_rate`, and the steady phase's
average `api_main_thread_cpu_pct` (100% is saturated) and `k6_cpu_pct` (its limit is 100% per
core in `k6_cpus`).

Note the run's commit and whether it had uncommitted changes, in case the code has moved on.

### 3. Work out what limits throughput

- **Headroom**: the API main thread's CPU against the achieved rate. It rises roughly in
  proportion, so `achieved_rps / (api_main_thread_cpu_pct / 100)` at the busier clean steps
  estimates the rate at which the main thread would saturate: the API's CPU-bound limit, whether
  or not the run reached it. It's a rough guide (cost per request tends to rise a little near
  saturation), but it gives a figure even for a `k6_limit_reached` run.
- **The latency curve**: where p95 starts to climb, and how fast. Steady low p95 and then a sharp
  rise at the failing step is plain saturation. Latency climbing well before the main thread is
  busy suggests something other than CPU: an event-loop stall (synchronous work, a big JSON
  serialisation), GC pauses, or work that grows with the number of records the run has created.
  One step with a p95 far out of line with its neighbours, when the steps either side are fine,
  is usually a one-off stall (GC, JIT); `timeseries.csv` (10 s periods) shows whether it was a
  brief spike or sustained.
- **Errors**: if `failed_rate` is the threshold that failed, read `api.log` and
  `k6-console.txt` for what failed (timeouts, connection resets, 5xx).
- **k6 near its limit**: when `k6_cpu_pct` is near its limit, measured latency includes k6
  reading responses late, so latency at those steps overstates the API's.
- **Growth over the run**: the workload creates orders throughout, so the store grows step by
  step. If CPU per iteration (`api_main_thread_cpu_pct / achieved_rps`) climbs from step to step
  rather than staying flat, something scales with the store (e.g. listing), and the limit will
  fall as data grows.

For where the API's CPU goes, or why CPU per request is high, suggest `/profile`: it finds the
code responsible. This skill says how much load the API takes and what runs out first, not which
code to change.

If a `<focus>` was given, read the result in its light and lead with that: for a feature (e.g.
"listing orders"), how its requests' share of the mix bears on the limit and whether CPU per
iteration grows with what it does; for a change (e.g. "after the listing change"), what the
change should move (the limit, the headroom, the latency curve) and whether this run shows it,
suggesting `/load-test compare` against an earlier run to be sure. Then summarise the rest
briefly.

`vmstat.log` shows the whole machine (run queue `r`, idle `id`): if something else was busy, the
run isn't representative; say so.

If nothing is limiting the API below the rates tested, say so plainly. Don't invent findings.

### 4. Report

```
## Load test: <report dir>

<commit> (uncommitted changes, if so) · <k6 args, or default steps> · API cores <api_cpus>,
k6 cores <k6_cpus>

### Verdict
<one or two sentences: the limit (or that it wasn't found and why), and what runs out first>

### By step
A short table of the steps that matter: target rate, achieved rate, p95, API main thread %,
k6 CPU % (the lowest, where latency starts to rise, and the last few).

### What limits throughput
- 2–4 bullets: CPU headroom and the projected saturation rate, the latency curve, anything out
  of line, with evidence.

### Next steps
- e.g. `/profile` to find where the API's CPU goes, a run with more cores for k6
  (`API_CPUS=0 K6_CPUS=1,2,3`) to find the limit, or a compare after a change.
```

Keep it short.

## Comparing runs

`/load-test compare <before> [<after>] [<focus>]`: whether a change, usually meant to improve
throughput, made a difference. Diagnose only here too: don't edit code.

### C1. Get the two reports

`<before>` (and `<after>`, if given) name directories under `test/load-test/reports/`: a full
name, or an unambiguous part of one such as its label. If one matches nothing or several, list
the candidates and stop. Each must be a breaking-point run with per-step CPU (see step 1).

If there's no `<after>`, test the current code with **the same k6 args and core split as
`<before>`** (its `run.json` has `k6_args`, `api_cpus` and `k6_cpus`), so the runs are
comparable:

```
API_CPUS=<before's api_cpus> K6_CPUS=<before's k6_cpus> \
  test/load-test/run.sh test/load-test/breaking-point.k6.js <label> [-- <before's k6 args>]
```

(The env vars can be left out when they are the defaults, `0,1` and `2,3`.) `<label>` is e.g.
`after-<focus>` or `after-<before's label>`. Run it in the background and act on the exit code as
in step 1. Don't change k6 args or cores for the after run alone: if the user wants different
settings, both runs need them, and `<before>`'s code may no longer be checked out. Say so, and
leave making a new before run to the user.

### C2. Compare

```
node test/load-test/scripts/compare.mjs <before-dir> <after-dir>
```

It writes `<after-dir>/comparison.md` (the last line printed) and exits:

- **0**: the runs are comparable; go on.
- **1**: written, but the runs aren't fully comparable (different k6 args, core split or
  workload, k6 errored, the API died, no per-step CPU in one run, different machine conditions,
  or the arguments in the wrong order); the reasons are printed and at the top of
  `comparison.md`. Different k6 args, core split or machine conditions make the comparison
  unreliable: report that and stop, unless the user asked for it anyway. Otherwise go on, and
  mention it.

**Machine conditions** matter more here than in `/profile`, which compares shares of CPU time:
these figures are absolute. On the same laptop, CPU per request for both the API and k6 doubled
between two sessions (battery power, a busy desktop), far beyond the few percent between
back-to-back runs. `compare.mjs` checks this with k6's CPU per iteration as a control (k6 does the
same work whatever the API does). If it reports different conditions, the before run is too
old to compare against: suggest re-running the before code (e.g. `git stash`, run, `git stash
pop`, or a checkout of the before commit) right before the after run, and leave that to the
user.
- **2**: it couldn't be made (a missing or malformed `run.json`, or not a breaking-point run).
  Report the message and stop.

### C3. Read the comparison and the change

Read `comparison.md` in full. Its summary judges three measures, each against a noise allowance
calibrated on back-to-back runs of the same code (its "How changes are judged" section gives the
figures), plus the k6 control row, which should say "same conditions":

- **Limit**: the failing step, when a run found one. Steps are 250 rps apart by default, and
  identical code can fail a step either side, so only a bigger move counts. If only one run found
  the limit, the other only bounds it from below, and the verdict is often **unresolved**.
- **API CPU ms per iteration**, over the steps both runs passed cleanly. Back-to-back runs vary
  by up to ~7%, and the allowance is ×1.15, so it shows changes of about 15% or more. The most
  sensitive measure, and the one that still works when neither run found the limit (k6 ran out first):
  **lower** means the API does the same work for less CPU, so it has more headroom, and the
  projected saturation rate rises in proportion.
- **p95 latency**, as a geometric mean of after/before ratios over the clean steps where k6 wasn't
  near its limit. Noisy: a single step's p95 can differ ×2 between identical runs, and the
  allowance on the mean is ×1.75. Latency at low load is mostly fixed overhead, so a CPU saving
  often shows here only weakly; it's the main measure for a change aimed at stalls or latency.
  Don't build a finding on one step's p95.

Work out what the change was meant to affect: the `<focus>` argument, else ask. Then:

- See what changed in the code: `git diff` / `git log` between the runs' commits (both in
  `comparison.md`); if either run had uncommitted changes, the diff alone may not show the
  before code, so say what you can and can't tell.
- Read the by-step table too: where the change shows (at every rate, or only the higher ones),
  and whether a step's status changed.
- Look for side effects: a CPU saving with worse latency (e.g. batching), or a limit that moved
  while CPU per iteration didn't (then something other than CPU was the limit; see step 3).

How to read the verdicts:

- **lower** CPU, or a **higher** limit: the change worked, by about the change shown.
- **no clear change** with the figures moving the right way: not proven. The allowances are
  for single runs; a small improvement needs repeated runs of both before and after code to
  show. Say that, and leave it to the user.
- Ignore the projected saturation rate as evidence on its own: it follows CPU per iteration and
  carries the same noise.
- **no clear change** with the figures barely moving, or the wrong verdict: the change didn't
  help, or made it worse; read the code to see why.

### C4. Report

```
## Load test comparison: <before dir> → <after dir>

<before commit> → <after commit> (uncommitted changes, if so) · <k6 args, cores> ·
comparable / not comparable because <reasons>

### Verdict
<one or two sentences: improved / not shown / worse, by how much, and how sure>

### The measures
- Limit: <before> → <after>, <verdict>
- API CPU per iteration: <before> → <after> ms (<change>, noise ×<allowance>), <verdict>;
  projected saturation <before> → <after> rps; k6 control <change> (same conditions, or not)
- p95 latency: <change> (noise ×<allowance>), <verdict>
- Why: <what the code change did, from the diff, and why it moves these figures>

### Next steps
- e.g. commit the change, `/profile compare` to see where the CPU saving came from, or a run
  with more cores for k6 to find the limit itself.
```

Keep it short. Cite `src/*.ts:line` where it helps.

## Files

- `.claude/diagnostics.json`: the project manifest (build, start, readiness, source root,
  workload); `scripts/diagnostics-manifest.mjs` documents it and the workload contract.
- `test/load-test/run.sh`: runs a test end to end; its header documents options and output.
- `test/load-test/breaking-point.k6.js`: the stepped-rate scenario and its thresholds; its header
  documents the env vars (`START_RPS`, `STEP_RPS`, `MAX_RPS`, `STEP_SECONDS`, `MAX_P95_MS`, ...).
- `test/load-test/monitor.sh`: records CPU and memory for the API, its threads and k6.
- `test/load-test/scripts/run-result.mjs`: turns k6's summary and the monitor's logs into
  `run.json`'s per-step results and verdict; its header documents the statuses and verdicts.
- `test/load-test/scripts/compare.mjs`: compares two runs into `comparison.md`; its header
  documents how changes are judged.
- `test/load-test/ramp.k6.js`: a fixed-VU ramp test, not used by this skill.
