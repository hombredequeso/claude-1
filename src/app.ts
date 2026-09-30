import Koa from 'koa';
import Router from '@koa/router';
import { koaSwagger } from 'koa2-swagger-ui';
import { openApiSpec } from './openapi/openapi.js';
import { createInMemoryOrderStore } from './persistence/adapters/order/in-memory-order-store.js';
import type { OrderStore } from './persistence/ports/order-store.js';
import { bodilessErrorEnvelope, errorEnvelope } from './routes/error-envelope.js';
import { registerOrderRoutes } from './routes/order/order-routes.js';

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
const health = (ctx: Koa.Context) => {
  ctx.status = 200;
  ctx.body = 'ok';
};

type Dependencies = {
  readonly orderStore: OrderStore;
};

// Only API endpoints go on this router, not the docs infrastructure
// (/openapi.json, /docs) — that keeps `router.stack` a clean inventory of
// the routes the OpenAPI spec is expected to describe.
export const createRouter = ({ orderStore }: Dependencies) => {
  const router = new Router();
  router.get('/health', health);
  registerOrderRoutes(router, orderStore);
  return router;
};

export const createApp = () => {
  const app = new Koa();
  const router = createRouter({ orderStore: createInMemoryOrderStore() });

  app.use(errorEnvelope);
  app.use(bodilessErrorEnvelope);

  app.use(async (ctx, next) => {
    if (ctx.path === '/openapi.json' && ctx.method === 'GET') {
      ctx.status = 200;
      ctx.body = openApiSpec;
      return;
    }
    await next();
  });

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
