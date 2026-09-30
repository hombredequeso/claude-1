import { describe, it, expect } from 'vitest';
import request from 'supertest';
import Koa from 'koa';
import { errorEnvelope } from './error-envelope.js';

class StubHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly expose: boolean,
    readonly headers?: Record<string, unknown>
  ) {
    super(message);
  }
}

const serverThrowing = (error: unknown) => {
  const app = new Koa();
  app.silent = true;
  app.use(errorEnvelope);
  app.use(() => {
    throw error;
  });
  return request(app.callback());
};

describe('errorEnvelope', () => {
  it('uses an exposed client error message and copies its string headers', async () => {
    const response = await serverThrowing(
      new StubHttpError('slow down', 429, true, { 'Retry-After': '30', 'X-Ignored': 5 })
    ).get('/');

    expect([response.status, response.headers['retry-after'], response.headers['x-ignored'], response.body]).toStrictEqual([
      429,
      '30',
      undefined,
      { error: { code: 'TOO_MANY_REQUESTS', message: 'slow down' } },
    ]);
  });

  it('replaces an unexposed client error message with the reason phrase', async () => {
    const response = await serverThrowing(new StubHttpError('internal detail', 403, false)).get('/');

    expect([response.status, response.body]).toStrictEqual([
      403,
      { error: { code: 'FORBIDDEN', message: 'Forbidden' } },
    ]);
  });

  it('keeps a thrown 5xx status but hides its message', async () => {
    const response = await serverThrowing(new StubHttpError('db down', 503, false)).get('/');

    expect([response.status, response.body]).toStrictEqual([
      503,
      { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
    ]);
  });

  it('treats an error without a status as a 500', async () => {
    const response = await serverThrowing(new Error('boom')).get('/');

    expect([response.status, response.body]).toStrictEqual([
      500,
      { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } },
    ]);
  });
});
