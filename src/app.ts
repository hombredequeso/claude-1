import Koa from 'koa';
import Router from '@koa/router';
import bodyParser from 'koa-bodyparser';
import { koaSwagger } from 'koa2-swagger-ui';
import { openApiSpec } from './openapi/openapi.js';
import { createInMemoryOrderStore } from './persistence/adapters/order/in-memory-order-store.js';
import { registerOrderRoutes } from './routes/order/order-routes.js';

// Only API endpoints go on this router, not the docs infrastructure
// (/openapi.json, /docs) — that keeps `router.stack` a clean inventory of
// the routes the OpenAPI spec is expected to describe.
export const router = new Router();

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Health check
 *     description: Liveness probe for uptime and readiness monitoring.
 *     tags:
 *       - Health
 *     responses:
 *       200:
 *         description: The service is healthy.
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 *               example: ok
 */
router.get('/health', (ctx) => {
  ctx.status = 200;
  ctx.body = 'ok';
});

registerOrderRoutes(router, createInMemoryOrderStore());

type HttpError = Error & { status: number; expose: boolean };

const isHttpError = (err: unknown): err is HttpError =>
  err instanceof Error && 'status' in err && typeof (err as HttpError).status === 'number';

export const createApp = () => {
  const app = new Koa();

  app.use(async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      const status = isHttpError(err) && err.status >= 400 && err.status < 500 ? err.status : 500;
      const message = status < 500 && err instanceof Error ? err.message : 'An unexpected error occurred';
      ctx.status = status;
      ctx.body = { error: { code: status === 400 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR', message } };
    }
  });

  app.use(async (ctx, next) => {
    if (ctx.path === '/openapi.json' && ctx.method === 'GET') {
      ctx.status = 200;
      ctx.body = openApiSpec;
      return;
    }
    await next();
  });

  app.use(bodyParser());

  app.use(
    koaSwagger({
      routePrefix: '/docs',
      swaggerOptions: { url: '/openapi.json' },
    })
  );

  app.use(router.routes());
  app.use(router.allowedMethods());

  return app;
};
