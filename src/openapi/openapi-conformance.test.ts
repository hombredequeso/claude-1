import { describe, it, expect } from 'vitest';
import request from 'supertest';
import * as openApiResponseValidatorModule from 'openapi-response-validator';

// The package's shipped .d.ts declares an ESM `export default` for a CJS
// build with no "type" field, which TS under NodeNext resolves to the
// whole module namespace rather than the class — cast around it.
type ResponseValidator = {
  validateResponse: (status: string, body: unknown) => unknown;
}
type ResponseValidatorConstructor = new (args: {
  responses: Record<string, { schema: unknown }>;
  components?: unknown;
}) => ResponseValidator;

const OpenAPIResponseValidator = (
  openApiResponseValidatorModule as unknown as { default: ResponseValidatorConstructor }
).default;
import { createApp } from '../app.js';
import { openApiSpec } from './openapi.js';

type DocumentedResponse = {
  content?: Record<string, { schema?: unknown }>;
}

type HttpMethod = 'get' | 'post';

const toValidatorResponses = (responses: Record<string, DocumentedResponse>) =>
  Object.fromEntries(
    Object.entries(responses).map(([status, response]) => {
      const content = response.content ?? {};
      const [firstMediaType] = Object.values(content);
      return [status, { schema: firstMediaType?.schema ?? {} }];
    })
  );

const validateAgainstSpec = (path: string, method: HttpMethod, status: number, body: unknown) => {
  const responses = openApiSpec.paths?.[path]?.[method]?.responses;
  if (!responses) {
    throw new Error(`openapi.json has no documented responses for ${method.toUpperCase()} ${path}`);
  }

  const validator = new OpenAPIResponseValidator({
    responses: toValidatorResponses(responses),
    components: openApiSpec.components ?? {},
  });

  return validator.validateResponse(String(status), body);
};

const newServer = () => request(createApp().callback());

const orderId = '3f2b8c1e-9a4d-4e7f-b6a1-2c5d8e9f0a1b';
const unknownOrderId = '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f';

const serverWithOrder = async () => {
  const server = newServer();
  await server.post('/orders').send({ id: orderId, description: 'Two boxes of widgets' });
  return server;
};

describe('GET /health response conforms to openapi.json', () => {
  it('matches the documented schema for its status code', async () => {
    const response = await newServer().get('/health');

    expect(validateAgainstSpec('/health', 'get', response.status, response.text)).toBeUndefined();
  });
});

describe('/orders responses conform to openapi.json', () => {
  it.each([
    ['a 200 page', '/orders'],
    ['a 400 for an invalid limit', '/orders?limit=0'],
  ])('GET /orders returns %s', async (_, url) => {
    const response = await (await serverWithOrder()).get(url);

    expect(validateAgainstSpec('/orders', 'get', response.status, response.body)).toBeUndefined();
  });

  it.each([
    ['a 201 created order', { id: orderId, description: 'Two boxes of widgets' }],
    ['a 400 for a missing field', { id: orderId }],
    ['a 422 for a non-GUID id', { id: 'order-1', description: 'Two boxes of widgets' }],
    ['a 413 for a body over 1 MB', { id: orderId, description: 'x'.repeat(1024 * 1024 + 1) }],
  ])('POST /orders returns %s', async (_, body) => {
    const response = await newServer().post('/orders').send(body);

    expect(validateAgainstSpec('/orders', 'post', response.status, response.body)).toBeUndefined();
  });

  it('POST /orders returns a 409 for a duplicate id', async () => {
    const response = await (await serverWithOrder())
      .post('/orders')
      .send({ id: orderId, description: 'Two boxes of widgets' });

    expect(validateAgainstSpec('/orders', 'post', response.status, response.body)).toBeUndefined();
  });

  it.each([
    ['a 200 order', orderId],
    ['a 404 for an unknown id', unknownOrderId],
  ])('GET /orders/{id} returns %s', async (_, id) => {
    const response = await (await serverWithOrder()).get(`/orders/${id}`);

    expect(validateAgainstSpec('/orders/{id}', 'get', response.status, response.body)).toBeUndefined();
  });

  it.each(['cancel', 'complete'])('POST /orders/{id}/%s returns 200, 409 and 404 as documented', async (operation) => {
    const server = await serverWithOrder();
    const path = `/orders/{id}/${operation}`;

    const succeeded = await server.post(`/orders/${orderId}/${operation}`);
    const conflicted = await server.post(`/orders/${orderId}/${operation}`);
    const notFound = await server.post(`/orders/${unknownOrderId}/${operation}`);

    expect(
      [succeeded, conflicted, notFound].map((response) => [
        response.status,
        validateAgainstSpec(path, 'post', response.status, response.body),
      ])
    ).toStrictEqual([
      [200, undefined],
      [409, undefined],
      [404, undefined],
    ]);
  });
});
