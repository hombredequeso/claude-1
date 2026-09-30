import type Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import { errorResponse } from './error-response.js';

// Content-Length: 0 (as sent by many clients on a bodiless POST) counts as
// no body; a chunked request without a length is assumed to have one.
const hasNonEmptyBody = (ctx: Koa.Context) =>
  ctx.request.length !== undefined ? ctx.request.length > 0 : ctx.get('Transfer-Encoding') !== '';

const requireJsonContentType: Koa.Middleware = async (ctx, next) => {
  if (hasNonEmptyBody(ctx) && !ctx.request.is('application/json')) {
    ctx.status = 400;
    ctx.body = errorResponse('INVALID_REQUEST', 'Request body must be sent as application/json');
    return;
  }
  await next();
};

// Mounted on each route that reads a body, rather than app-wide, so that an
// unmatched path or method still gets its 404/405 whatever body it was sent.
export const jsonBody = [requireJsonContentType, bodyParser({ enableTypes: ['json'] })];
