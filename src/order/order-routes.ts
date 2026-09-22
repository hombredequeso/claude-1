import { randomUUID } from 'node:crypto';
import type Router from '@koa/router';
import type { RouterContext } from '@koa/router';
import { createOrder, cancelOrder, completeOrder, type Order, type OrderError } from './order.js';
import type { OrderStore } from './order-store.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const parsePageParams = (ctx: RouterContext): { limit: number; offset: number } => {
  const rawLimit = Number(ctx.query.limit ?? DEFAULT_LIMIT);
  const rawOffset = Number(ctx.query.offset ?? 0);

  const limit = Number.isInteger(rawLimit) ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;
  const offset = Number.isInteger(rawOffset) ? rawOffset : 0;

  return { limit, offset };
};

type TransitionResult = { kind: 'Success'; order: Order } | { kind: 'Error'; error: OrderError };

const findOrderOrRespondNotFound = (ctx: RouterContext, store: OrderStore): Order | null => {
  const order = store.findById(ctx.params.id);
  if (order === null) {
    ctx.status = 404;
    ctx.body = { error: { code: 'ORDER_NOT_FOUND', message: `Order ${ctx.params.id} not found` } };
    return null;
  }

  return order;
};

const respondToTransitionResult = (ctx: RouterContext, orderId: string, result: TransitionResult): void => {
  switch (result.kind) {
    case 'Success':
      ctx.status = 200;
      ctx.body = result.order;
      return;
    case 'Error':
      ctx.status = 409;
      ctx.body = {
        error: {
          code: 'ILLEGAL_STATUS_TRANSITION',
          message: `Cannot transition order ${orderId} from ${result.error.from} to ${result.error.to}`,
        },
      };
      return;
  }
};

/**
 * @openapi
 * components:
 *   schemas:
 *     Order:
 *       type: object
 *       properties:
 *         id: { type: string }
 *         description: { type: string }
 *         status: { type: string, enum: [Created, Cancelled, Completed] }
 *       required: [id, description, status]
 *     OrderInput:
 *       type: object
 *       properties:
 *         description: { type: string }
 *       required: [description]
 *     Error:
 *       type: object
 *       properties:
 *         error:
 *           type: object
 *           properties:
 *             code: { type: string }
 *             message: { type: string }
 *           required: [code, message]
 *       required: [error]
 */
export const registerOrderRoutes = (router: Router, store: OrderStore): void => {
  /**
   * @openapi
   * /orders:
   *   get:
   *     summary: List orders
   *     description: Returns a page of orders.
   *     tags: [Orders]
   *     parameters:
   *       - name: limit
   *         in: query
   *         schema: { type: integer, default: 20, maximum: 100 }
   *       - name: offset
   *         in: query
   *         schema: { type: integer, default: 0 }
   *     responses:
   *       200:
   *         description: A page of orders.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 items:
   *                   type: array
   *                   items: { $ref: '#/components/schemas/Order' }
   *                 total: { type: integer }
   *   post:
   *     summary: Create an order
   *     description: Creates a new order with a server-generated id.
   *     tags: [Orders]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema: { $ref: '#/components/schemas/OrderInput' }
   *     responses:
   *       201:
   *         description: The created order.
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/Order' }
   *       400:
   *         description: Request body is missing a description.
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/Error' }
   */
  router.get('/orders', (ctx) => {
    const { limit, offset } = parsePageParams(ctx);
    ctx.status = 200;
    ctx.body = store.list({ limit, offset });
  });

  router.post('/orders', (ctx) => {
    const body = ctx.request.body as { description?: unknown } | undefined;
    if (typeof body?.description !== 'string' || body.description.length === 0) {
      ctx.status = 400;
      ctx.body = { error: { code: 'INVALID_REQUEST', message: 'description is required' } };
      return;
    }

    const result = createOrder({ description: body.description }, randomUUID);
    switch (result.kind) {
      case 'Success':
        store.save(result.order);
        ctx.status = 201;
        ctx.body = result.order;
        return;
      case 'Error':
        ctx.status = 409;
        ctx.body = {
          error: {
            code: 'ILLEGAL_STATUS_TRANSITION',
            message: `Cannot transition order from ${result.error.from} to ${result.error.to}`,
          },
        };
        return;
    }
  });

  /**
   * @openapi
   * /orders/{id}:
   *   get:
   *     summary: Get an order
   *     tags: [Orders]
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: The requested order.
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/Order' }
   *       404:
   *         description: No order with that id.
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/Error' }
   */
  router.get('/orders/:id', (ctx) => {
    const order = store.findById(ctx.params.id);
    if (order === null) {
      ctx.status = 404;
      ctx.body = { error: { code: 'ORDER_NOT_FOUND', message: `Order ${ctx.params.id} not found` } };
      return;
    }

    ctx.status = 200;
    ctx.body = order;
  });

  /**
   * @openapi
   * /orders/{id}/cancel:
   *   post:
   *     summary: Cancel an order
   *     description: Aggregate operation — transitions an order to Cancelled. Only legal from Created.
   *     tags: [Orders]
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: The cancelled order.
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/Order' }
   *       404:
   *         description: No order with that id.
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/Error' }
   *       409:
   *         description: Order is not in a cancellable state.
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/Error' }
   */
  router.post('/orders/:id/cancel', (ctx) => {
    const order = findOrderOrRespondNotFound(ctx, store);
    if (order === null) return;

    const result = cancelOrder(order);
    if (result.kind === 'Success') {
      store.save(result.order);
    }
    respondToTransitionResult(ctx, order.id, result);
  });

  /**
   * @openapi
   * /orders/{id}/complete:
   *   post:
   *     summary: Complete an order
   *     description: Aggregate operation — transitions an order to Completed. Only legal from Created.
   *     tags: [Orders]
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: The completed order.
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/Order' }
   *       404:
   *         description: No order with that id.
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/Error' }
   *       409:
   *         description: Order is not in a completable state.
   *         content:
   *           application/json:
   *             schema: { $ref: '#/components/schemas/Error' }
   */
  router.post('/orders/:id/complete', (ctx) => {
    const order = findOrderOrRespondNotFound(ctx, store);
    if (order === null) return;

    const result = completeOrder(order);
    if (result.kind === 'Success') {
      store.save(result.order);
    }
    respondToTransitionResult(ctx, order.id, result);
  });
};
