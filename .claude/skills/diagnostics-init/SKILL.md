---
name: diagnostics-init
description: Set up the project manifest, .claude/diagnostics.json, that the diagnostic tooling (profiling/run.sh, test/load-test/run.sh, /profile) reads to build, start, check and drive the app — working out each field from the repo — and, if there's no workload yet, write a starter k6 workload from the OpenAPI spec. Then checks the setup end to end with a short profiling run. Also reviews an existing manifest against the code. Use when asked to set up diagnostics, profiling or load testing for a project, when the run scripts report a missing or invalid manifest, or when the app's build, entry point, port, health check or endpoints have changed.
allowed-tools: Bash(node scripts/diagnostics-manifest.mjs:*), Bash(node .claude/skills/openapi-test/scripts/list-endpoints.mjs:*), Bash(profiling/run.sh:*), Bash(k6 version), Read, Write, Edit, Grep, Glob
---

# Diagnostics init

Writes `.claude/diagnostics.json`, the project manifest that tells the diagnostic tooling how to
build, start, check and drive this project's app, and, when there isn't one, a starter
**workload**: the k6 module that drives a representative request mix through the app. Both
formats are defined in the header of `scripts/diagnostics-manifest.mjs`: the fields, and the
workload contract. Read that header first. It is the spec this skill fills in, and it wins if
anything here disagrees with it.

**Write only the manifest and the workload.** Don't change the app's code or config (`src/`,
`tsconfig.json`, `package.json`) to make it fit the manifest, even for a small fix like turning
on source maps or adding a health route. Report what's missing, suggest the change, and leave it
to the user.

## Usage

```
/diagnostics-init                       # write the manifest (and a starter workload if needed),
                                        # or review the existing manifest
/diagnostics-init workload [<spec>]     # (re)write only the starter workload, from <spec>
                                        # (an openapi.json) or the one found in the repo
```

## Steps

### 1. Check the tooling is here

The manifest is only useful with the tooling that reads it. Check these exist:
`scripts/diagnostics-manifest.mjs`, `scripts/diagnostics-app.sh`, `test/load-test/lib/workload.js`,
`profiling/run.sh`. If any is missing, say which and stop: this skill sets up a project that has
the tooling, it doesn't install the tooling.

Check k6 is installed (`k6 version`). If not, carry on, but say the check in step 5 can't run.

### 2. If there's already a manifest

If `.claude/diagnostics.json` exists, don't overwrite it. Validate it:

```
node scripts/diagnostics-manifest.mjs json
```

Then work out each field from the repo as in step 3, and compare. Report:
- validation errors, if any;
- each field where the repo now says something different, with the evidence (e.g. "`start.entry`
  is `dist/server.js`, but `tsconfig.json` now has `outDir: build`");
- whether the workload's `requestNames` and routes still match the spec (from step 4's endpoint
  listing): operations it calls that are gone, and new ones it doesn't call.

Offer the specific edits. Make them only if the user agrees. Then go to step 5.

For `/diagnostics-init workload`, skip to step 4.

### 3. Work out each field

For every field, find the evidence in the repo; don't fill a field from convention alone. Note
the file and line each value came from, for the report. If the evidence is missing or
contradictory, use the fallback below or ask; don't guess.

| Field | Where to look | If unclear |
|---|---|---|
| `build` | `package.json` `scripts.build`, run with the package manager the lockfile shows (`pnpm-lock.yaml` → `pnpm build`) | `null` if the app runs from source with no build |
| `start.entry` | `scripts.start` (e.g. `node dist/server.js`); else the source file that calls `.listen(`, mapped through `tsconfig.json` `rootDir` → `outDir` and `.ts` → `.js` | ask |
| `start.nodeArgs` | node options in `scripts.start` (e.g. `--max-old-space-size`), not the script path | `[]`. Don't add `--enable-source-maps`: the tools add their own flags |
| `start.env` | env vars the app needs to start that have no default (grep `process.env` around startup), and that `scripts.start` sets | `{}`. Never put secrets here; if the app needs one, stop and ask |
| `portEnv` | the env var read where the port passed to `.listen(` is set | ask. If the port is hard-coded, the tooling can't choose one: report it |
| `readiness.path` | a `GET` route with no side effects that returns 2xx once the app is up: a health route (`/health`, `/healthz`, `/ready`, ...) | a cheap `GET` from the spec that needs no data (e.g. an empty list); say so. If there's none, ask |
| `readiness.timeoutSeconds` | | `10` |
| `shutdownTimeoutSeconds` | | `10` |
| `sourceRoot` | `tsconfig.json` `rootDir`, or where the entry's source is | ask |
| `workload` | an existing module that exports `createWorkload` (grep `test/load-test/lib/`) | step 4 writes one |

Check these too, and report any that fail; they don't stop the manifest being written, but each
one breaks some of the tooling:
- **Source maps**: `tsconfig.json` has `sourceMap: true` (or `inlineSourceMap`), and the maps
  point back into `sourceRoot`. Without them, profiles show `dist/` lines, not source lines.
- **Clean shutdown**: the app handles `SIGTERM` by closing the server and exiting normally (e.g.
  `process.once('SIGTERM', ...)` → `server.close(() => process.exit(0))`). Without it, node can't
  write the CPU profile, and `profiling/run.sh` fails.
- **Port**: the port comes from `portEnv`, not a constant.

### 4. Write a starter workload (if there isn't one)

Find the OpenAPI spec: the `<spec>` argument, else an `openapi.json` in the repo (outside
`node_modules/` and `dist/`). If it's missing but a `package.json` script generates it (e.g.
`generate:openapi`), say so and ask before running it. If there's no spec, ask the user which
requests make up a representative mix, and write the workload from their answer and the routes
in the code.

List the endpoints; don't read the raw spec by hand:

```
node .claude/skills/openapi-test/scripts/list-endpoints.mjs <spec> --out=<scratchpad>/endpoints.json
```

Write the workload to `test/load-test/lib/<resource>-mix.js`, after the main resource (e.g.
`order-mix.js`). If a file of that name exists, ask before overwriting it. Implement the contract
in `scripts/diagnostics-manifest.mjs`. If `test/load-test/lib/order-mix.js` exists, model the
code on it: it's a worked example of the contract. The module:

- **Exports `createWorkload({ baseUrl, timeout = '60s' })`**, returning `{ requestNames, seed,
  iteration }`. Imports only k6 modules (`k6/http`, `k6`): it runs in k6, not node. k6 has
  `crypto.randomUUID()`.
- **Tags every request with a `name`** of the form `METHOD /path/{param}` (the spec's path
  template, so per-id URLs share one metric series), and `setup: METHOD /path` for requests made
  by `seed`. `requestNames` lists every tag used, setup ones included.
- **`seed(count)`** creates `count` records with the main create operation, in one `http.batch`,
  and `fail()`s with the base URL in the message if any fail. It returns their ids for
  `iteration`. If the API generates ids, take them from the response bodies; if the client
  supplies them, generate UUIDs.
- **`iteration(seedIds)`** picks one action at random, by fixed ratios, so the mix is spread
  through the run. Start from 10% writes and 90% reads, split across the operations in the spec,
  and say these are placeholders in the header comment.
  - Writes create a record and, if the spec has them, follow it through its state changes
    (update, or actions like `/cancel`) or delete it. They act only on records the iteration
    created, never seeded ones, so reads of seeded ids keep working.
  - Reads pick from the seeded ids plus the ones this VU created (VUs don't share memory).
- **`check()`s each response** for the success status the spec documents, and, where it's cheap,
  one field that shows the right record came back (e.g. the `id`).
- **Synthesizes request bodies** from the spec's `example`s, else minimal valid instances of the
  schema, following "Synthesizing request data" in `.claude/skills/openapi-test/SKILL.md`.
- **Starts with a header comment** naming the API, saying it implements the workload contract in
  `scripts/diagnostics-manifest.mjs`, and giving the mix as a short table of ratios.

Leave out, and list in the report:
- operations that need auth: if the spec requires credentials, ask how to get a test credential;
  don't put one in the file;
- operations that need data the workload can't create (a reference to another resource with no
  create operation);
- operations that aren't representative traffic (admin, bulk import, docs, the health route).

If the manifest is new, its `workload` is this file's path. If it exists, offer to point it here
(step 2).

### 5. Check it works end to end

Validate the manifest:

```
node scripts/diagnostics-manifest.mjs json
```

Fix what it reports (a field written in step 3 or 4) and validate again. Then, if k6 is
installed, do a short real run. It builds the app, starts it, waits for readiness, runs the
workload's `seed` and iterations, and stops the app, so it checks every field:

```
profiling/run.sh diagnostics-init -- -e ITERATIONS=500
```

The last line printed is the report directory. Act on the exit code:
- **0**: the setup works.
- **1**: requests failed. Read `k6-console.txt` in the report directory: the failed `check`s say
  which requests. It's usually the workload (wrong body, path or expected status). Fix it and run
  again, at most twice; after that, report what's failing.
- **2**: the run couldn't be set up. The message names the step: the build, start or readiness
  (fix the manifest field, or report what the app is missing, from `build.log` and `api.log`), or
  no profile written (the app didn't exit cleanly on `SIGTERM`: report it, see step 3).

Don't run `test/load-test/run.sh`: a load test takes minutes. The profiling run covers the same
manifest and workload.

### 6. Report

```
## Diagnostics setup

<written / reviewed> `.claude/diagnostics.json` · workload `<path>` (<new / existing>)
Check: <passed: report dir / failed: why / not run: k6 not installed>

### Manifest
| Field | Value | From |
|---|---|---|
| build | `pnpm build` | package.json scripts.build |
| ... |

### Workload
<the mix, as in its header> · left out: <operations, and why>

### Needs attention
- Each failed check from step 3 (source maps, clean shutdown, port) or 5, with the change to
  make. Or "nothing".

### Next steps
- `/profile` for a CPU profile; `test/load-test/run.sh` for a load test; tune the workload's
  ratios to match production traffic, if it's known.
```

## Files

- `scripts/diagnostics-manifest.mjs`: validates and prints the manifest; its header documents
  the fields and the workload contract.
- `scripts/diagnostics-app.sh`: how the run scripts use the manifest to build, start, wait for
  and stop the app.
- `test/load-test/lib/workload.js`: loads the workload into the k6 scripts.
- `test/load-test/lib/order-mix.js`: this project's workload, a worked example of the contract.
- `.claude/skills/openapi-test/scripts/list-endpoints.mjs`: lists a spec's operations, grouped by
  resource, in create → read → update → delete order.
