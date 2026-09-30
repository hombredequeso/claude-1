import type { Router, RouterContext } from '@koa/router';
import { cancelOrder, completeOrder, createOrder } from '../../domain/order/order.js';
import type { IllegalStatusTransition, Order, CancelOrderResult, CompleteOrderResult } from '../../domain/order/order.js';
import type { OrderStore } from '../../persistence/ports/order-store.js';
import { errorResponse } from '../error-response.js';
import { jsonBody } from '../json-body.js';
import { parsePageRequest } from '../paging.js';
import { parseCreateOrderRequest } from './create-order-request.js';

const respondNotFound = (ctx: RouterContext, id: string) => {
  ctx.status = 404;
  ctx.body = errorResponse('NOT_FOUND', `Order ${id} not found`);
};

const respondIllegalTransition = (ctx: RouterContext, id: string, transition: IllegalStatusTransition) => {
  ctx.status = 409;
  ctx.body = errorResponse(
    'ILLEGAL_STATUS_TRANSITION',
    `Order ${id} cannot move from ${transition.from} to ${transition.to}`
  );
};

const respondOrder = (ctx: RouterContext, status: number, order: Order) => {
  ctx.status = status;
  ctx.body = order;
};

/**
 * @openapi
 * components:
 *   schemas:
 *     Order:
 *       type: object
 *       required: [id, description, status]
 *       additionalProperties: false
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *           example: 3f2b8c1e-9a4d-4e7f-b6a1-2c5d8e9f0a1b
 *         description:
 *           type: string
 *           example: Two boxes of widgets
 *         status:
 *           type: string
 *           enum: [Created, Cancelled, Completed]
 *           example: Created
 *     CreateOrderRequest:
 *       type: object
 *       required: [id, description]
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *           description: Client-supplied GUID for the new order. Never changes.
 *           example: 3f2b8c1e-9a4d-4e7f-b6a1-2c5d8e9f0a1b
 *         description:
 *           type: string
 *           description: Description of the order. Never changes.
 *           example: Two boxes of widgets
 *
 * /orders:
 *   get:
 *     summary: List orders
 *     description: Returns a page of orders, in the order they were created.
 *     tags: [Orders]
 *     parameters:
 *       - name: limit
 *         in: query
 *         description: Maximum number of orders to return.
 *         schema: { type: integer, default: 20, minimum: 1, maximum: 100 }
 *       - name: offset
 *         in: query
 *         description: Number of orders to skip.
 *         schema: { type: integer, default: 0, minimum: 0 }
 *     responses:
 *       200:
 *         description: A page of orders.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [items, total]
 *               additionalProperties: false
 *               properties:
 *                 items:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Order' }
 *                 total:
 *                   type: integer
 *                   description: Total number of orders, independent of limit and offset.
 *             example:
 *               items:
 *                 - id: 3f2b8c1e-9a4d-4e7f-b6a1-2c5d8e9f0a1b
 *                   description: Two boxes of widgets
 *                   status: Created
 *               total: 1
 *       400:
 *         description: "`INVALID_REQUEST` — limit or offset is not a valid integer in range."
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example:
 *               error:
 *                 code: INVALID_REQUEST
 *                 message: limit must be an integer between 1 and 100
 *   post:
 *     summary: Create an order
 *     description: Creates a new order in the Created status, using the client-supplied id.
 *     tags: [Orders]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/CreateOrderRequest' }
 *           example:
 *             id: 3f2b8c1e-9a4d-4e7f-b6a1-2c5d8e9f0a1b
 *             description: Two boxes of widgets
 *     responses:
 *       201:
 *         description: The created order.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Order' }
 *             example:
 *               id: 3f2b8c1e-9a4d-4e7f-b6a1-2c5d8e9f0a1b
 *               description: Two boxes of widgets
 *               status: Created
 *       400:
 *         description: "`INVALID_REQUEST` — the body is not sent as application/json, or is not a JSON object with string id and description."
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example:
 *               error:
 *                 code: INVALID_REQUEST
 *                 message: description is required and must be a string
 *       409:
 *         description: "`ORDER_ALREADY_EXISTS` — an order with this id already exists."
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example:
 *               error:
 *                 code: ORDER_ALREADY_EXISTS
 *                 message: Order 3f2b8c1e-9a4d-4e7f-b6a1-2c5d8e9f0a1b already exists
 *       413:
 *         description: "`PAYLOAD_TOO_LARGE` — the JSON body is larger than 1 MB."
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example:
 *               error:
 *                 code: PAYLOAD_TOO_LARGE
 *                 message: request entity too large
 *       422:
 *         description: "`VALIDATION_FAILED` — the id is not a GUID."
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example:
 *               error:
 *                 code: VALIDATION_FAILED
 *                 message: id must be a GUID
 */
const listOrders = (store: OrderStore) => async (ctx: RouterContext) => {
  const pageRequest = parsePageRequest(ctx.query);
  switch (pageRequest.kind) {
    case 'InvalidPageRequest':
      ctx.status = 400;
      ctx.body = errorResponse('INVALID_REQUEST', pageRequest.message);
      return;
    case 'ValidPageRequest': {
      const page = await store.list(pageRequest.page);
      ctx.status = 200;
      ctx.body = { items: page.items, total: page.total };
      return;
    }
    default:
      throw pageRequest satisfies never;
  }
};

const postOrder = (store: OrderStore) => async (ctx: RouterContext) => {
  const request = parseCreateOrderRequest(ctx.request.body);
  switch (request.kind) {
    case 'MalformedCreateOrderRequest':
      ctx.status = 400;
      ctx.body = errorResponse('INVALID_REQUEST', request.message);
      return;
    case 'InvalidCreateOrderRequest':
      ctx.status = 422;
      ctx.body = errorResponse('VALIDATION_FAILED', request.message);
      return;
    case 'ValidCreateOrderRequest': {
      if ((await store.findById(request.id)) !== null) {
        ctx.status = 409;
        ctx.body = errorResponse('ORDER_ALREADY_EXISTS', `Order ${request.id} already exists`);
        return;
      }
      const order = createOrder(request.id, request.description);
      await store.save(order);
      respondOrder(ctx, 201, order);
      return;
    }
    default:
      throw request satisfies never;
  }
};

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
 *         schema: { type: string, format: uuid }
 *         example: 3f2b8c1e-9a4d-4e7f-b6a1-2c5d8e9f0a1b
 *     responses:
 *       200:
 *         description: The requested order.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Order' }
 *             example:
 *               id: 3f2b8c1e-9a4d-4e7f-b6a1-2c5d8e9f0a1b
 *               description: Two boxes of widgets
 *               status: Created
 *       404:
 *         description: "`NOT_FOUND` — no order with that id."
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example:
 *               error:
 *                 code: NOT_FOUND
 *                 message: Order 3f2b8c1e-9a4d-4e7f-b6a1-2c5d8e9f0a1b not found
 */
const getOrder = (store: OrderStore) => async (ctx: RouterContext) => {
  const id = ctx.params['id'] ?? '';
  const order = await store.findById(id);
  if (order === null) {
    respondNotFound(ctx, id);
    return;
  }
  respondOrder(ctx, 200, order);
};

/**
 * @openapi
 * /orders/{id}/cancel:
 *   post:
 *     summary: Cancel an order
 *     description: Aggregate operation — moves a Created order to the Cancelled status.
 *     tags: [Orders]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *         example: 3f2b8c1e-9a4d-4e7f-b6a1-2c5d8e9f0a1b
 *     responses:
 *       200:
 *         description: The cancelled order.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Order' }
 *             example:
 *               id: 3f2b8c1e-9a4d-4e7f-b6a1-2c5d8e9f0a1b
 *               description: Two boxes of widgets
 *               status: Cancelled
 *       404:
 *         description: "`NOT_FOUND` — no order with that id."
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example:
 *               error:
 *                 code: NOT_FOUND
 *                 message: Order 3f2b8c1e-9a4d-4e7f-b6a1-2c5d8e9f0a1b not found
 *       409:
 *         description: "`ILLEGAL_STATUS_TRANSITION` — the order is already Cancelled or Completed."
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example:
 *               error:
 *                 code: ILLEGAL_STATUS_TRANSITION
 *                 message: Order 3f2b8c1e-9a4d-4e7f-b6a1-2c5d8e9f0a1b cannot move from Completed to Cancelled
 */
const postCancelOrder = (store: OrderStore) => async (ctx: RouterContext) => {
  const id = ctx.params['id'] ?? '';
  const order = await store.findById(id);
  if (order === null) {
    respondNotFound(ctx, id);
    return;
  }
  const result: CancelOrderResult = cancelOrder(order);
  switch (result.kind) {
    case 'IllegalStatusTransition':
      respondIllegalTransition(ctx, id, result);
      return;
    case 'OrderCancelled':
      await store.save(result.order);
      respondOrder(ctx, 200, result.order);
      return;
    default:
      throw result satisfies never;
  }
};

/**
 * @openapi
 * /orders/{id}/complete:
 *   post:
 *     summary: Complete an order
 *     description: Aggregate operation — moves a Created order to the Completed status.
 *     tags: [Orders]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *         example: 3f2b8c1e-9a4d-4e7f-b6a1-2c5d8e9f0a1b
 *     responses:
 *       200:
 *         description: The completed order.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Order' }
 *             example:
 *               id: 3f2b8c1e-9a4d-4e7f-b6a1-2c5d8e9f0a1b
 *               description: Two boxes of widgets
 *               status: Completed
 *       404:
 *         description: "`NOT_FOUND` — no order with that id."
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example:
 *               error:
 *                 code: NOT_FOUND
 *                 message: Order 3f2b8c1e-9a4d-4e7f-b6a1-2c5d8e9f0a1b not found
 *       409:
 *         description: "`ILLEGAL_STATUS_TRANSITION` — the order is already Cancelled or Completed."
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example:
 *               error:
 *                 code: ILLEGAL_STATUS_TRANSITION
 *                 message: Order 3f2b8c1e-9a4d-4e7f-b6a1-2c5d8e9f0a1b cannot move from Cancelled to Completed
 */
const postCompleteOrder = (store: OrderStore) => async (ctx: RouterContext) => {
  const id = ctx.params['id'] ?? '';
  const order = await store.findById(id);
  if (order === null) {
    respondNotFound(ctx, id);
    return;
  }
  const result: CompleteOrderResult = completeOrder(order);
  switch (result.kind) {
    case 'IllegalStatusTransition':
      respondIllegalTransition(ctx, id, result);
      return;
    case 'OrderCompleted':
      await store.save(result.order);
      respondOrder(ctx, 200, result.order);
      return;
    default:
      throw result satisfies never;
  }
};

export const registerOrderRoutes = (router: Router, store: OrderStore) => {
  router.get('/orders', listOrders(store));
  router.post('/orders', ...jsonBody, postOrder(store));
  router.get('/orders/:id', getOrder(store));
  router.post('/orders/:id/cancel', postCancelOrder(store));
  router.post('/orders/:id/complete', postCompleteOrder(store));
};
