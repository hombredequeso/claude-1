import type Router from '@koa/router';

const isDocumentableMethod = (method: string) => method !== 'HEAD' && method !== 'OPTIONS';

export const getRegisteredRoutes = (router: Router) =>
  router.stack.flatMap((layer) =>
    layer.methods.filter(isDocumentableMethod).map((method) => ({
      method: method.toLowerCase(),
      path: typeof layer.path === 'string' ? layer.path : layer.path.source,
    }))
  );
