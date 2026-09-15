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

/**
 * @openapi
 * /thing/{id}:
 *   get:
 *     summary: Get a thing
 *     description: Returns a thing identified by its id.
 *     tags:
 *       - Thing
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: The requested thing.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                 description:
 *                   type: string
 *               example:
 *                 id: abc123
 *                 description: thing abc123
 */
router.get('/thing/:id', (ctx) => {
  // if (ctx.params.id === '1') {
  //   throw new Exception('something went wrong');
  // }
  ctx.status = 200;
  ctx.body = { id: ctx.params.id, description: `thing ${ctx.params.id}` };
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
