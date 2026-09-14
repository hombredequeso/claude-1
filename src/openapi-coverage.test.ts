import { describe, it, expect } from 'vitest';
import { router } from './app.js';
import { openApiSpec } from './openapi.js';
import { getRegisteredRoutes } from './route-inventory.js';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

const getSpecRoutes = () => {
  const paths = openApiSpec.paths ?? {};

  return Object.entries(paths).flatMap(([path, pathItem]) =>
    HTTP_METHODS.filter((method) => pathItem[method] !== undefined).map((method) => ({ method, path }))
  );
};

const isSameRoute = (
  a: { method: string; path: string },
  b: { method: string; path: string }
) => a.method === b.method && a.path === b.path;

describe('openapi.json route coverage', () => {
  const registeredRoutes = getRegisteredRoutes(router);
  const specRoutes = getSpecRoutes();

  it('documents every registered route', () => {
    const undocumented = registeredRoutes.filter(
      (route) => !specRoutes.some((spec) => isSameRoute(spec, route))
    );

    expect(undocumented).toEqual([]);
  });

  it('does not document routes that no longer exist in code', () => {
    const phantom = specRoutes.filter(
      (spec) => !registeredRoutes.some((route) => isSameRoute(route, spec))
    );

    expect(phantom).toEqual([]);
  });
});
