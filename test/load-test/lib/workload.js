// Loads the project's workload: the k6 module named by the WORKLOAD env var
// (an absolute path), which implements the workload contract described in
// scripts/diagnostics-manifest.mjs. test/load-test/run.sh and profiling/run.sh
// set WORKLOAD from .claude/diagnostics.json; when running k6 by hand, pass
// it yourself, e.g. `k6 run -e WORKLOAD=$PWD/test/load-test/lib/order-mix.js ...`.
//
// Call from the init context (top level of a k6 script): require() only
// works there.
export const loadWorkload = (options) => {
  if (!__ENV.WORKLOAD) {
    throw new Error('WORKLOAD is not set: run via test/load-test/run.sh or profiling/run.sh, or pass -e WORKLOAD=<path>');
  }
  const { createWorkload } = require(__ENV.WORKLOAD);
  if (typeof createWorkload !== 'function') {
    throw new Error(`${__ENV.WORKLOAD} doesn't export createWorkload`);
  }
  return createWorkload(options);
};
