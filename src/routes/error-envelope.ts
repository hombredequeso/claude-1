import { STATUS_CODES } from 'node:http';
import type Koa from 'koa';
import { z } from 'zod';
import { errorResponse } from './error-response.js';

// The shape of an error thrown by middleware such as koa-bodyparser (via
// http-errors). Anything that doesn't match — including a plain Error with no
// status — is treated as an unexpected server error.
const thrownHttpErrorSchema = z.object({
  status: z.number().int().min(400).max(599),
  message: z.string().optional(),
  // http-errors marks 4xx errors `expose` when their message is meant for the client.
  expose: z.boolean().default(false),
  // A missing header map, or any non-string header value, is dropped rather
  // than failing the parse; the remaining string headers are kept.
  headers: z
    .record(z.string(), z.string().nullable().catch(null))
    .catch({})
    .transform((headers): [string, string][] =>
      Object.entries(headers).flatMap(([name, value]): [string, string][] => (value === null ? [] : [[name, value]]))
    ),
});

type ThrownHttpError = z.infer<typeof thrownHttpErrorSchema>;

// 'Payload Too Large' -> 'PAYLOAD_TOO_LARGE'. 400 keeps this API's own code.
const codeForStatus = (status: number) =>
  status === 400 ? 'INVALID_REQUEST' : (STATUS_CODES[status] ?? 'Request Failed').toUpperCase().replace(/[^A-Z0-9]+/g, '_');

const clientMessageOf = ({ status, message, expose }: ThrownHttpError) =>
  expose && message !== undefined ? message : (STATUS_CODES[status] ?? 'Request failed');

const clientErrorResponse = (error: unknown, httpError: ThrownHttpError) =>
  error instanceof SyntaxError
    ? errorResponse('INVALID_REQUEST', 'Request body is not valid JSON')
    : errorResponse(codeForStatus(httpError.status), clientMessageOf(httpError));

// Errors thrown by middleware (e.g. koa-bodyparser rejecting malformed or
// oversized JSON) are rendered in the standard error envelope rather than
// Koa's plain text.
export const errorEnvelope: Koa.Middleware = async (ctx, next) => {
  try {
    await next();
  } catch (error) {
    const parsed = thrownHttpErrorSchema.safeParse(error);
    if (!parsed.success || parsed.data.status >= 500) {
      ctx.status = parsed.success ? parsed.data.status : 500;
      ctx.body = errorResponse('INTERNAL_ERROR', 'An unexpected error occurred');
      ctx.app.emit('error', error, ctx);
      return;
    }
    ctx.status = parsed.data.status;
    parsed.data.headers.forEach(([name, value]) => ctx.set(name, value));
    ctx.body = clientErrorResponse(error, parsed.data);
  }
};

// Responses the router finishes without a body (unknown path, method not
// allowed on a path, unknown method) would otherwise fall back to Koa's plain
// text status message.
const envelopeForBodilessStatus = (status: number, method: string, path: string) => {
  switch (status) {
    case 404:
      return errorResponse('NOT_FOUND', `No resource at ${path}`);
    case 405:
      return errorResponse('METHOD_NOT_ALLOWED', `${method} is not allowed on ${path}`);
    case 501:
      return errorResponse('NOT_IMPLEMENTED', `${method} is not supported`);
    default:
      return null;
  }
};

export const bodilessErrorEnvelope: Koa.Middleware = async (ctx, next) => {
  await next();
  if (ctx.body !== undefined && ctx.body !== null) {
    return;
  }
  const status = ctx.status;
  const envelope = envelopeForBodilessStatus(status, ctx.method, ctx.path);
  if (envelope !== null) {
    ctx.body = envelope;
    // Assigning a body resets an implicit status (such as Koa's default 404) to 200.
    ctx.status = status;
  }
};
