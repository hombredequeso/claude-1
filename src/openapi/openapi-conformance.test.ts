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
}) => ResponseValidator;

const OpenAPIResponseValidator = (
  openApiResponseValidatorModule as unknown as { default: ResponseValidatorConstructor }
).default;
import { createApp } from '../app.js';
import { openApiSpec } from './openapi.js';

type DocumentedResponse = {
  content?: Record<string, { schema?: unknown }>;
}

const toValidatorResponses = (responses: Record<string, DocumentedResponse>) =>
  Object.fromEntries(
    Object.entries(responses).map(([status, response]) => {
      const content = response.content ?? {};
      const [firstMediaType] = Object.values(content);
      return [status, { schema: firstMediaType?.schema ?? {} }];
    })
  );

describe('GET /health response conforms to openapi.json', () => {
  it('matches the documented schema for its status code', async () => {
    const response = await request(createApp().callback()).get('/health');

    const responses = openApiSpec.paths?.['/health']?.get?.responses;
    if (!responses) {
      throw new Error('openapi.json has no documented responses for GET /health');
    }

    const validator = new OpenAPIResponseValidator({
      responses: toValidatorResponses(responses),
    });

    const validationError = validator.validateResponse(String(response.status), response.text);

    expect(validationError).toBeUndefined();
  });
});
