import type Router from '@koa/router';

const isDocumentableMethod = (method: string) => method !== 'HEAD' && method !== 'OPTIONS';

// Koa path params (`:id`) and OpenAPI path params (`{id}`) use different
// syntax for the same thing — normalize to OpenAPI's so routes compare equal.
const toOpenApiPath = (path: string) => path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

export const getRegisteredRoutes = (router: Router) =>
  router.stack.flatMap((layer) =>
    layer.methods.filter(isDocumentableMethod).map((method) => ({
      method: method.toLowerCase(),
      path: toOpenApiPath(typeof layer.path === 'string' ? layer.path : layer.path.source),
    }))
  );
