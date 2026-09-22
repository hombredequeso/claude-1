import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';

describe('POST /orders with malformed JSON body', () => {
  it('returns 400 with the standard error envelope', async () => {
    const response = await request(createApp().callback())
      .post('/orders')
      .set('Content-Type', 'application/json')
      .send('{ not valid json');

    // The parser's message text varies by Node/V8 version, so only its shape is asserted here.
    const { error } = response.body as { error: { code: string; message: string } };

    expect(response.status).toBe(400);
    expect({ code: error.code, messageIsNonEmptyString: typeof error.message === 'string' && error.message.length > 0 }).toStrictEqual({
      code: 'INVALID_REQUEST',
      messageIsNonEmptyString: true,
    });
  });
});
