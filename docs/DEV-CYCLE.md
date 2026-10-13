# Development Cycle

A reference for how the testing and quality tools (package.json scripts and Claude Code skills) fit
into a typical cycle: clean repo → implement a feature → commit.

In a normal cycle you run `pnpm test` while you work, then `/review` and `/commit` at the end. The
other tools come in only when the change calls for them. Nothing in the repo runs them
automatically: there are no git hooks or CI workflows, so each step is one you choose to run.

## The cycle

**1. Starting point (clean `main`)**
- Optionally run `pnpm test` to confirm a green baseline, so later failures are clearly yours.
- If you expect the change to affect performance, record a baseline now with `/load-test` and/or
  `/profile`, while the code is still unchanged. Their reports go to `test/load-test/reports/` and
  `profiling/reports/` (both gitignored). Later you can only compare against a baseline you saved,
  and it's awkward to get one after you've started editing.

**2. Implement (the inner loop)**
- `pnpm test` (vitest) is the main feedback loop. Run it often while you build the feature layer by
  layer, as `docs/DEV-PROCESS.md` describes. It includes `openapi-coverage.test.ts`: if you add or
  remove a route without updating `src/openapi/openapi.ts`, it fails.
- `pnpm lint`, `pnpm depcruise`, `pnpm knip` and `pnpm build` (tsc) can be run whenever you like as
  quick checks. `depcruise` matters most when you add files or imports across layers.
- `pnpm test:server` is a quick smoke test. It starts the real app on a random port, calls
  `/health` and shuts down. It's handy after you change wiring in `app.ts` or `server.ts`.

**3. Verify behaviour, only if the HTTP API changed**
- Run `pnpm generate:openapi`. It writes `openapi/openapi.json`, which is gitignored, so it's only
  there to feed the next step.
- Start the app (`pnpm dev`), then run `/openapi-test ./openapi/openapi.json localhost:3000`. It
  sends real requests and reports where the running API disagrees with its spec, or does something
  bad the spec doesn't cover (500s, missing error bodies, and so on). It finds problems unit tests
  miss, but it's slow, so use it per feature rather than on every edit.

**4. Check performance, only if the change touches a hot path**
- `/load-test compare <baseline-report>` tells you whether throughput, or the CPU cost per request,
  changed.
- `/profile compare <baseline-report>` tells you where the CPU time moved, with file:line
  locations.
- Both only diagnose and never edit code. If one finds a problem, you fix it and run the compare
  again.

**5. Pre-commit gate**
- `/review` covers most of the package.json commands. On both the base and your change, it runs
  lint, depcruise, knip, tsc, the tests, `complexity` (FTA file scores) and `complexity:functions`.
  It reports only the regressions your change introduced, plus correctness bugs it finds in the
  diff. That's why you rarely need to run `complexity` or `complexity:functions` by hand.
- Fix whatever it reports, then `git add`.

**6. Commit**
- `/commit` writes the message from the staged diff and asks you to approve it before committing.

## Quick reference

| Tool | When | How often |
|---|---|---|
| `pnpm test` | While implementing | Constantly |
| `lint` / `depcruise` / `knip` / `build` | During, as quick checks | Occasionally |
| `test:server` | After app or server wiring changes | Rarely |
| `generate:openapi` + `/openapi-test` | After API changes, before commit | Per API feature |
| `/load-test`, `/profile` | Baseline before, `compare` after | Only for performance-relevant changes |
| `complexity`, `complexity:functions` | Run inside `/review` | Rarely by hand |
| `test:output-json` | Tooling and agents that need machine-readable results | Not used by hand |
| `/review` | Before staging or committing | Every change |
| `/commit` | Last step | Every change |

## Setup skills (not every cycle)

- `/diagnostics-init` sets up `.claude/diagnostics.json`, the manifest that `/load-test` and
  `/profile` need. Re-run it only when the build, entry point, port, health check or endpoints
  change.
- `/scaffold-api` is for starting a new project only.

## Possible improvement

If you want these steps to run without being asked, the cheapest option is a pre-commit hook
running `lint`, `depcruise`, `knip`, `build` and `test`. Right now every step depends on you
remembering to run it.
