import Koa from 'koa';
import Router from '@koa/router';
import { koaSwagger } from 'koa2-swagger-ui';
import { openApiSpec } from './openapi/openapi.js';

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

export const createApp = () => {
  const app = new Koa();

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
