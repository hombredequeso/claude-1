// Loads the project's workload: the k6 module named by the WORKLOAD env var
// (an absolute path), which implements the workload contract described in
// scripts/diagnostics-manifest.mjs, pointed at the API at BASE_URL.
// test/load-test/run.sh and profiling/run.sh set both, from
// .claude/diagnostics.json and the port they start the API on; when running
// k6 by hand, pass them yourself:
//   k6 run -e BASE_URL=http://localhost:<port> -e WORKLOAD=$PWD/<manifest workload> ...
//
// Call from the init context (top level of a k6 script): require() only
// works there. Options other than baseUrl are passed on to createWorkload.
export const loadWorkload = (options = {}) => {
  if (!__ENV.WORKLOAD) {
    throw new Error('WORKLOAD is not set: run via test/load-test/run.sh or profiling/run.sh, or pass -e WORKLOAD=<path>');
  }
  if (!__ENV.BASE_URL) {
    throw new Error('BASE_URL is not set: run via test/load-test/run.sh or profiling/run.sh, or pass -e BASE_URL=<url>');
  }
  const { createWorkload } = require(__ENV.WORKLOAD);
  if (typeof createWorkload !== 'function') {
    throw new Error(`${__ENV.WORKLOAD} doesn't export createWorkload`);
  }
  return createWorkload({ ...options, baseUrl: __ENV.BASE_URL });
};
