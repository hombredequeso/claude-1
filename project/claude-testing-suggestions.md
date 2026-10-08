Your current setup covers four things well: CPU hot spots (`/profile`, including before/after comparison and noise runs), throughput limits (`load-tests/`, which has scripts but no skill yet), static quality regressions (`/review`) and contract conformance (`/openapi-test`). Below are the gaps I'd fill, grouped by your three goals, plus a few changes that would make the skills work on any TypeScript project.

## 0. First, make the skills portable

`/profile` and `load-tests/run.sh` are tied to "the orders API": the build command, port, health check and `order-mix.js`. Before adding more skills, I'd pull those details into one **project manifest**, for example `.claude/diagnostics.json`:

```jsonc
{
  "build": "pnpm build",
  "start": "node --enable-source-maps dist/server.js",
  "port_env": "PORT",
  "ready": "GET /health → 200",
  "workload": "load-tests/lib/order-mix.js",      // k6 module exporting the request mix
  "seed": "scripts/seed.mts",                       // optional: create N records
  "sourceRoot": "src"
}
```

Every runtime skill would then read this file, and a small `/diagnostics-init` skill would generate it for a new repo. It could also write a starter workload from the OpenAPI spec, since you already have `list-endpoints.mjs`.

## 1. Diagnosis: new runtime signals

| Skill                                         | What it catches                                                                        | How                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`/load-test`**                              | Throughput limit, latency at that limit, what saturates first                          | Wrap `run.sh` the way `/profile` wraps its runner. Read `run.json`, `timeseries.csv` and pidstat, and report whether CPU, the event loop or GC gave out first.                                                                                                                                                       |
| **`/memory`** (your `project/memory-test.md`) | Leaks, unbounded caches and Maps, retained closures                                    | Take a heap snapshot after warm-up, run N iterations, take another, and diff the retained objects by constructor and allocation site. Also run a soak test that tracks RSS and heapUsed against request count; a steadily growing heap is the giveaway. `--heapsnapshot-signal` or the inspector protocol both work. |
| **`/event-loop`**                             | Sync I/O, blocking JSON or regex work, long tasks                                      | Use `perf_hooks.monitorEventLoopDelay` plus `--trace-sync-io`. Report p99 loop delay and the stacks of the sync calls.                                                                                                                                                                                               |
| **`/handles`** (your `tcp-connections.md`)    | Connection, socket, timer and listener leaks; missing keep-alive; no graceful shutdown | Record `process.getActiveResourcesInfo()` before, during and after load, and check that the API drains to zero after SIGTERM. OTEL is useful here, but a lighter `async_hooks`/diagnostics_channel probe is enough for a first version.                                                                              |
| **`/scaling`** ⭐                             | Algorithmic complexity: O(n²) code, full scans, list endpoints with no pagination      | Run the same workload with 1k, 10k and 100k seeded records, then fit CPU per request (and heap) against data size.                                                                                                                                                                                                   |

**`/scaling` is the most valuable item on this list for catching bad generated code.** A plain profile can show a hot spot, but it can't tell you whether that hot spot grows with the data. The iterator/list fix in your history is exactly the kind of problem this test detects.

## 2. Detecting undesirable generated code from the measurements

Add a **signature catalogue**: a reference file the diagnosis skills consult that maps what a measurement shows to the likely code smell and what to grep for:

- CPU per request rises with record count → linear scan, sort inside a loop, `array.find` inside a loop
- High GC share, or `structuredClone`/`JSON.parse(JSON.stringify())` near the top of the profile → defensive deep copies
- Zod `object()`/`parse` construction per request → schemas built inside handlers instead of at module level
- Heap retained by `Map`/`Array` growing with request count → unbounded cache or memo
- Event-loop delay spikes plus `*Sync` frames → sync filesystem or crypto calls in a request path
- Active handles growing → listeners or timers that are never removed

Each entry would also have a **static counterpart**: an ESLint rule or ast-grep pattern. Then a runtime finding can be confirmed in the code, and the static check goes into `/review` so the same smell is caught earlier next time.

The next step is **performance regression gating**. Commit a baseline (`perf-baselines/*.json`: CPU per request, p95 latency, heap per request, scaling exponent), and have a `/perf-check` skill run short versions of `/profile`, `/scaling` and `/memory`. It compares the results with the baseline, using the spread from your noise runs as the tolerance, and returns a pass or fail verdict.

## 3. Verifying that generated code works

- **Mutation testing (Stryker)**: tells you whether the generated tests actually test anything. AI-written tests often pass whatever the implementation does. A `/mutation` skill could run Stryker on the changed files only and report surviving mutants with the code they mutated.
- **Tests written only from the spec**: a fresh agent sees only `specs/*.md` and the OpenAPI spec, never the implementation, and writes the tests. If those tests fail against the implementation, the cause is either a spec ambiguity or a bug. This follows the same pattern as your context-free `/commit` and `/review` agents.
- **Spec traceability**: map each requirement in `specs/*.md` to the tests that cover it, and report requirements with no test.
- **Differential testing**: your history includes "Delete existing customer and order implementation", so you already regenerate code. Replaying the same request sequence against the old and new builds and diffing the responses is cheap, and it catches behaviour drift.
- **Property-based and fuzz testing**: generate fast-check tests for the domain layer (invariants such as "a cancelled order can't be completed"). For the HTTP layer, extend `/openapi-test` to send schema-derived boundary values.
- **Fault injection at the ports**: you already have `persistence/ports` and `adapters`, so you can wrap an adapter to throw, slow down or partially fail, and check that the API returns proper error envelopes with no 500s, hangs or leaks.

## 4. Pulling it together

- **`/verify`**: one entry point that runs the cheap checks first and stops at the first failure: `/review` quality tools → tests → mutation testing on the diff → `/openapi-test` → `/perf-check`. It ends in a single report.
- **`/diagnose <symptom>`**: a triage skill that routes "slow", "memory grows" or "falls over at load" to the right skill above.
- **Hooks**: a Stop or PostToolUse hook that runs the fast static checks automatically after code generation, keeping the slow runtime checks for `/verify`.

## 5. Testing the skills themselves

I'd build this early. Create a set of **planted-defect branches or fixtures**, each containing one known problem: an O(n²) list endpoint, an unbounded cache, a sync `readFileSync` in a handler, a leaked listener, a test that asserts nothing. Then check that each skill flags its defect, and that it stays quiet on clean `main`. This is how you'll know the detection actually works rather than just producing plausible output. The `skill-creator` skill's eval tooling can run these as benchmarks.

**Order I'd suggest:** the manifest (needed for everything to be portable), then `/scaling`, `/memory` and the planted-defect fixtures, then `/perf-check` with baselines, then `/verify`. Want me to start with the manifest and refactor `/profile` to use it?
