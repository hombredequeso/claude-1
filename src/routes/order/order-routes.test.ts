import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';

const id = '3f2b8c1e-9a4d-4e7f-b6a1-2c5d8e9f0a1b';
const otherId = '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const description = 'Two boxes of widgets';

const newServer = () => request(createApp().callback());

const serverWithOrder = async () => {
  const server = newServer();
  await server.post('/orders').send({ id, description });
  return server;
};

describe('POST /orders', () => {
  it('creates an order in the Created status', async () => {
    const response = await newServer().post('/orders').send({ id, description });

    expect(response.status).toBe(201);
    expect(response.body).toStrictEqual({ id, description, status: 'Created' });
  });

  it('persists the created order', async () => {
    const server = await serverWithOrder();

    const response = await server.get(`/orders/${id}`);

    expect(response.body).toStrictEqual({ id, description, status: 'Created' });
  });

  it('rejects an id that is already in use with 409', async () => {
    const server = await serverWithOrder();

    const response = await server.post('/orders').send({ id, description: 'Something else' });

    expect(response.status).toBe(409);
    expect(response.body).toStrictEqual({
      error: { code: 'ORDER_ALREADY_EXISTS', message: `Order ${id} already exists` },
    });
  });

  it('rejects a missing id with 400', async () => {
    const response = await newServer().post('/orders').send({ description });

    expect(response.status).toBe(400);
    expect(response.body).toStrictEqual({
      error: { code: 'INVALID_REQUEST', message: 'id is required and must be a string' },
    });
  });

  it('rejects a non-string description with 400', async () => {
    const response = await newServer().post('/orders').send({ id, description: 42 });

    expect(response.status).toBe(400);
    expect(response.body).toStrictEqual({
      error: { code: 'INVALID_REQUEST', message: 'description is required and must be a string' },
    });
  });

  it('rejects a body that is not a JSON object with 400', async () => {
    const response = await newServer().post('/orders').send([id, description]);

    expect(response.status).toBe(400);
    expect(response.body).toStrictEqual({
      error: { code: 'INVALID_REQUEST', message: 'Request body must be a JSON object' },
    });
  });

  it('rejects malformed JSON with 400', async () => {
    const response = await newServer()
      .post('/orders')
      .set('Content-Type', 'application/json')
      .send('{"id": ');

    expect(response.status).toBe(400);
    expect(response.body).toStrictEqual({
      error: { code: 'INVALID_REQUEST', message: 'Request body is not valid JSON' },
    });
  });

  it('rejects an id that is not a GUID with 422', async () => {
    const response = await newServer().post('/orders').send({ id: 'order-1', description });

    expect(response.status).toBe(422);
    expect(response.body).toStrictEqual({
      error: { code: 'VALIDATION_FAILED', message: 'id must be a GUID' },
    });
  });

  it('rejects a body that is both malformed and has a non-GUID id with 400', async () => {
    const response = await newServer().post('/orders').send({ id: 'order-1' });

    expect(response.status).toBe(400);
    expect(response.body).toStrictEqual({
      error: { code: 'INVALID_REQUEST', message: 'description is required and must be a string' },
    });
  });
});

describe('GET /orders/{id}', () => {
  it('returns the order', async () => {
    const server = await serverWithOrder();

    const response = await server.get(`/orders/${id}`);

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({ id, description, status: 'Created' });
  });

  it('returns 404 for an unknown id', async () => {
    const response = await newServer().get(`/orders/${id}`);

    expect(response.status).toBe(404);
    expect(response.body).toStrictEqual({
      error: { code: 'NOT_FOUND', message: `Order ${id} not found` },
    });
  });
});

describe('GET /orders', () => {
  it('returns an empty page when there are no orders', async () => {
    const response = await newServer().get('/orders');

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({ items: [], total: 0 });
  });

  it('returns orders in creation order', async () => {
    const server = await serverWithOrder();
    await server.post('/orders').send({ id: otherId, description: 'One crate' });

    const response = await server.get('/orders');

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({
      items: [
        { id, description, status: 'Created' },
        { id: otherId, description: 'One crate', status: 'Created' },
      ],
      total: 2,
    });
  });

  it('pages results with limit and offset, reporting the full total', async () => {
    const server = await serverWithOrder();
    await server.post('/orders').send({ id: otherId, description: 'One crate' });

    const response = await server.get('/orders?limit=1&offset=1');

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({
      items: [{ id: otherId, description: 'One crate', status: 'Created' }],
      total: 2,
    });
  });

  it.each(['0', '101', 'abc', '1.5'])('rejects limit=%s with 400', async (limit) => {
    const response = await newServer().get(`/orders?limit=${limit}`);

    expect(response.status).toBe(400);
    expect(response.body).toStrictEqual({
      error: { code: 'INVALID_REQUEST', message: 'limit must be an integer between 1 and 100' },
    });
  });

  it.each(['-1', 'abc'])('rejects offset=%s with 400', async (offset) => {
    const response = await newServer().get(`/orders?offset=${offset}`);

    expect(response.status).toBe(400);
    expect(response.body).toStrictEqual({
      error: { code: 'INVALID_REQUEST', message: 'offset must be a non-negative integer' },
    });
  });

  it('reports both an invalid limit and an invalid offset, limit first', async () => {
    const response = await newServer().get('/orders?limit=0&offset=-1');

    expect(response.status).toBe(400);
    expect(response.body).toStrictEqual({
      error: {
        code: 'INVALID_REQUEST',
        message: 'limit must be an integer between 1 and 100; offset must be a non-negative integer',
      },
    });
  });

  it('rejects a repeated limit parameter with 400', async () => {
    const response = await newServer().get('/orders?limit=1&limit=2');

    expect(response.status).toBe(400);
    expect(response.body).toStrictEqual({
      error: { code: 'INVALID_REQUEST', message: 'limit must be an integer between 1 and 100' },
    });
  });
});

describe('POST /orders/{id}/cancel', () => {
  it('cancels a Created order', async () => {
    const server = await serverWithOrder();

    const response = await server.post(`/orders/${id}/cancel`);

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({ id, description, status: 'Cancelled' });
  });

  it('persists the cancellation', async () => {
    const server = await serverWithOrder();
    await server.post(`/orders/${id}/cancel`);

    const response = await server.get(`/orders/${id}`);

    expect(response.body).toStrictEqual({ id, description, status: 'Cancelled' });
  });

  it('rejects cancelling a Completed order with 409', async () => {
    const server = await serverWithOrder();
    await server.post(`/orders/${id}/complete`);

    const response = await server.post(`/orders/${id}/cancel`);

    expect(response.status).toBe(409);
    expect(response.body).toStrictEqual({
      error: {
        code: 'ILLEGAL_STATUS_TRANSITION',
        message: `Order ${id} cannot move from Completed to Cancelled`,
      },
    });
  });

  it('rejects cancelling a Cancelled order with 409', async () => {
    const server = await serverWithOrder();
    await server.post(`/orders/${id}/cancel`);

    const response = await server.post(`/orders/${id}/cancel`);

    expect(response.status).toBe(409);
    expect(response.body).toStrictEqual({
      error: {
        code: 'ILLEGAL_STATUS_TRANSITION',
        message: `Order ${id} cannot move from Cancelled to Cancelled`,
      },
    });
  });

  it('returns 404 for an unknown id', async () => {
    const response = await newServer().post(`/orders/${id}/cancel`);

    expect(response.status).toBe(404);
    expect(response.body).toStrictEqual({
      error: { code: 'NOT_FOUND', message: `Order ${id} not found` },
    });
  });
});

describe('POST /orders/{id}/complete', () => {
  it('completes a Created order', async () => {
    const server = await serverWithOrder();

    const response = await server.post(`/orders/${id}/complete`);

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({ id, description, status: 'Completed' });
  });

  it('persists the completion', async () => {
    const server = await serverWithOrder();
    await server.post(`/orders/${id}/complete`);

    const response = await server.get(`/orders/${id}`);

    expect(response.body).toStrictEqual({ id, description, status: 'Completed' });
  });

  it('rejects completing a Cancelled order with 409', async () => {
    const server = await serverWithOrder();
    await server.post(`/orders/${id}/cancel`);

    const response = await server.post(`/orders/${id}/complete`);

    expect(response.status).toBe(409);
    expect(response.body).toStrictEqual({
      error: {
        code: 'ILLEGAL_STATUS_TRANSITION',
        message: `Order ${id} cannot move from Cancelled to Completed`,
      },
    });
  });

  it('rejects completing a Completed order with 409', async () => {
    const server = await serverWithOrder();
    await server.post(`/orders/${id}/complete`);

    const response = await server.post(`/orders/${id}/complete`);

    expect(response.status).toBe(409);
    expect(response.body).toStrictEqual({
      error: {
        code: 'ILLEGAL_STATUS_TRANSITION',
        message: `Order ${id} cannot move from Completed to Completed`,
      },
    });
  });

  it('returns 404 for an unknown id', async () => {
    const response = await newServer().post(`/orders/${id}/complete`);

    expect(response.status).toBe(404);
    expect(response.body).toStrictEqual({
      error: { code: 'NOT_FOUND', message: `Order ${id} not found` },
    });
  });
});
