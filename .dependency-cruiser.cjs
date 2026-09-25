/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'domain-no-persistence',
      severity: 'error',
      comment: 'Entities are the innermost layer — they must not depend on persistence.',
      from: { path: '^src/domain' },
      to: { path: '^src/persistence' },
    },
    {
      name: 'domain-no-routes',
      severity: 'error',
      comment: 'Entities are the innermost layer — they must not depend on routing.',
      from: { path: '^src/domain' },
      to: { path: '^src/routes' },
    },
    {
      name: 'routes-no-persistence-adapters',
      severity: 'error',
      comment:
        'Routes depend on persistence ports (interfaces), not concrete adapters. ' +
        'Adapters are wired in by the composition root (app.ts).',
      from: { path: '^src/routes' },
      to: { path: '^src/persistence/adapters' },
    },
    {
      name: 'persistence-ports-no-adapters',
      severity: 'error',
      comment: 'A port must not depend on any of its own adapters.',
      from: { path: '^src/persistence/ports' },
      to: { path: '^src/persistence/adapters' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'No circular dependencies.',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    exclude: { path: 'node_modules|dist' },
  },
};
