import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';

const id = '3f2b8c1e-9a4d-4e7f-b6a1-2c5d8e9f0a1b';

const newServer = () => request(createApp().callback());

describe('request bodies', () => {
  it.each([
    ['application/x-www-form-urlencoded', `id=${id}&description=test`],
    ['text/plain', JSON.stringify({ id, description: 'test' })],
  ])('rejects a %s body with 400', async (contentType, body) => {
    const response = await newServer().post('/orders').set('Content-Type', contentType).send(body);

    expect([response.status, response.body]).toStrictEqual([
      400,
      { error: { code: 'INVALID_REQUEST', message: 'Request body must be sent as application/json' } },
    ]);
  });

  it('does not create an order from a rejected body', async () => {
    const server = newServer();
    await server.post('/orders').type('form').send({ id, description: 'test' });

    const response = await server.get(`/orders/${id}`);

    expect(response.status).toBe(404);
  });

  it('accepts a bodiless POST', async () => {
    const response = await newServer().post(`/orders/${id}/cancel`);

    expect(response.status).toBe(404);
  });
});

describe('bodies sent to routes that do not read one', () => {
  it('still gets 404 for an unknown path', async () => {
    const response = await newServer().post('/nope').set('Content-Type', 'text/plain').send('x');

    expect([response.status, response.body]).toStrictEqual([
      404,
      { error: { code: 'NOT_FOUND', message: 'No resource at /nope' } },
    ]);
  });

  it('still gets 404 for an unknown path sent malformed JSON', async () => {
    const response = await newServer().post('/nope').set('Content-Type', 'application/json').send('{"id": ');

    expect(response.status).toBe(404);
  });

  it('still gets 405 with an Allow header for a method not allowed on a path', async () => {
    const response = await newServer().delete('/orders').type('form').send({ id });

    expect([response.status, response.headers['allow'], response.body]).toStrictEqual([
      405,
      'HEAD, GET, POST',
      { error: { code: 'METHOD_NOT_ALLOWED', message: 'DELETE is not allowed on /orders' } },
    ]);
  });

  it('is ignored by the health check', async () => {
    const response = await newServer().get('/health').set('Content-Type', 'text/plain').send('x');

    expect([response.status, response.text]).toStrictEqual([200, 'ok']);
  });
});

describe('errors thrown while reading a body', () => {
  it('reports an oversized JSON body as 413 PAYLOAD_TOO_LARGE', async () => {
    const description = 'x'.repeat(1024 * 1024 + 1);

    const response = await newServer().post('/orders').send({ id, description });

    expect([response.status, response.body]).toStrictEqual([
      413,
      { error: { code: 'PAYLOAD_TOO_LARGE', message: 'request entity too large' } },
    ]);
  });
});

describe('responses the router finishes without a body', () => {
  it('renders an unknown path as a NOT_FOUND envelope', async () => {
    const response = await newServer().get('/order-items');

    expect([response.status, response.body]).toStrictEqual([
      404,
      { error: { code: 'NOT_FOUND', message: 'No resource at /order-items' } },
    ]);
  });

  it('renders a method not allowed on a path as a METHOD_NOT_ALLOWED envelope, keeping the Allow header', async () => {
    const response = await newServer().delete('/orders');

    expect([response.status, response.headers['allow'], response.body]).toStrictEqual([
      405,
      'HEAD, GET, POST',
      { error: { code: 'METHOD_NOT_ALLOWED', message: 'DELETE is not allowed on /orders' } },
    ]);
  });

  it('leaves the health check body alone', async () => {
    const response = await newServer().get('/health');

    expect([response.status, response.text]).toStrictEqual([200, 'ok']);
  });
});
