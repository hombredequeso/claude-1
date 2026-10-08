// Reads .claude/diagnostics.json, the project manifest that tells the
// diagnostic tooling (profiling/, load-tests/ and the skills that drive them)
// how to build, start, check and drive this project's app. Everything
// project-specific those tools need is here, so they can be pointed at
// another TypeScript HTTP service by writing its manifest and workload.
//
// Usage:
//   node scripts/diagnostics-manifest.mjs shell   print bash assignments, for
//                                                 eval in the run scripts
//   node scripts/diagnostics-manifest.mjs json    print the manifest, resolved
//   import { loadManifest } from './diagnostics-manifest.mjs'
// The project root is the current directory for the CLI.
//
// Fields (paths are relative to the project root):
//   build                  shell command that builds the app, or null if it
//                          runs from source without a build
//   start.entry            the script node runs to start the app
//   start.nodeArgs         node options for every run (the tools add their
//                          own, e.g. --cpu-prof, after these)
//   start.env              extra environment variables for the app
//   portEnv                the environment variable the app reads its listen
//                          port from; the tools choose the port
//   readiness.path         a GET path that returns 2xx once the app is ready
//   readiness.timeoutSeconds  how long to wait for that after starting, in
//                          whole seconds
//   shutdownTimeoutSeconds how long the app may take to exit after SIGTERM,
//                          in whole seconds.
//                          The app must exit normally (not be killed by the
//                          signal) on SIGTERM, or node can't write a CPU
//                          profile or heap data on exit.
//   sourceRoot             the directory holding the app's own source; the
//                          build must write source maps back to it
//   workload               a k6 module that drives a representative request
//                          mix through the app; see "Workload contract"
//
// Workload contract: the workload module exports
//   createWorkload({ baseUrl, timeout }) => { requestNames, seed, iteration }
// where
//   requestNames  every `name` tag the workload gives its requests (including
//                 those made by seed), so per-request metrics can be reported
//   seed(count)   called once from k6's setup(): creates `count` records the
//                 iterations can read, and returns data for iteration
//   iteration(seedData)  one unit of the request mix
// The k6 scripts load it with require(), from the path in their WORKLOAD
// env var, which the run scripts set from this manifest.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const MANIFEST_PATH = '.claude/diagnostics.json';

const ManifestSchema = z
  .object({
    build: z.string().min(1).nullable(),
    start: z
      .object({
        entry: z.string().min(1),
        nodeArgs: z.array(z.string()).default([]),
        env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).default({}),
      })
      .strict(),
    portEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    readiness: z
      .object({
        path: z.string().startsWith('/'),
        timeoutSeconds: z.int().positive().default(10),
      })
      .strict(),
    shutdownTimeoutSeconds: z.int().positive().default(10),
    sourceRoot: z.string().min(1),
    workload: z.string().min(1),
  })
  .strict();

export const loadManifest = (projectRoot) => {
  const path = join(projectRoot, MANIFEST_PATH);
  if (!existsSync(path)) {
    throw new Error(`No diagnostics manifest at ${path}: write one, see scripts/diagnostics-manifest.mjs`);
  }
  const parsed = ManifestSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    throw new Error(`Invalid diagnostics manifest ${path}:\n${z.prettifyError(parsed.error)}`);
  }
  const manifest = parsed.data;
  const sourceRoot = resolve(projectRoot, manifest.sourceRoot);
  if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
    throw new Error(`Diagnostics manifest ${path}: sourceRoot ${manifest.sourceRoot} is not a directory`);
  }
  const workload = resolve(projectRoot, manifest.workload);
  if (!existsSync(workload)) {
    throw new Error(`Diagnostics manifest ${path}: workload ${manifest.workload} doesn't exist`);
  }
  return { ...manifest, paths: { sourceRoot, workload, entry: resolve(projectRoot, manifest.start.entry) } };
};

const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
const shellArray = (values) => `(${values.map(shellQuote).join(' ')})`;

const shellAssignments = (manifest) =>
  [
    `DIAG_BUILD=${shellQuote(manifest.build ?? '')}`,
    `DIAG_ENTRY=${shellQuote(manifest.start.entry)}`,
    `DIAG_NODE_ARGS=${shellArray(manifest.start.nodeArgs)}`,
    `DIAG_ENV=${shellArray(Object.entries(manifest.start.env).map(([name, value]) => `${name}=${value}`))}`,
    `DIAG_PORT_ENV=${shellQuote(manifest.portEnv)}`,
    `DIAG_READY_PATH=${shellQuote(manifest.readiness.path)}`,
    `DIAG_READY_TIMEOUT_S=${shellQuote(manifest.readiness.timeoutSeconds)}`,
    `DIAG_SHUTDOWN_TIMEOUT_S=${shellQuote(manifest.shutdownTimeoutSeconds)}`,
    `DIAG_SOURCE_ROOT=${shellQuote(manifest.sourceRoot)}`,
    `DIAG_WORKLOAD=${shellQuote(manifest.paths.workload)}`,
  ].join('\n');

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const format = process.argv[2];
  if (format !== 'shell' && format !== 'json') {
    console.error('Usage: node scripts/diagnostics-manifest.mjs shell|json');
    process.exit(2);
  }
  try {
    const manifest = loadManifest(process.cwd());
    console.log(format === 'shell' ? shellAssignments(manifest) : JSON.stringify(manifest, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
