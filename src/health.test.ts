import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';

describe('GET /health', () => {
  it('returns 200 "ok"', async () => {
    const response = await request(createApp().callback()).get('/health');

    expect(response.status).toBe(200);
    expect(response.text).toBe('ok');
  });
});
