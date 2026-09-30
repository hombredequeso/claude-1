import { z } from 'zod';
import type { PageRequest } from '../persistence/ports/page.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

type QueryValue = string | string[] | undefined;

type ValidPageRequest = {
  readonly kind: 'ValidPageRequest';
  readonly page: PageRequest;
};

type InvalidPageRequest = {
  readonly kind: 'InvalidPageRequest';
  readonly message: string;
};

export type ParsePageResult = ValidPageRequest | InvalidPageRequest;

// Query values arrive as strings (or arrays, for a repeated parameter). Only
// plain digit strings are accepted, so '', '1.5', '-1' and '1e2' are rejected
// rather than coerced.
const nonNegativeInteger = (message: string) =>
  z.string({ error: message }).regex(/^\d+$/, { error: message }).transform(Number);

const LIMIT_MESSAGE = `limit must be an integer between 1 and ${MAX_LIMIT}`;
const OFFSET_MESSAGE = 'offset must be a non-negative integer';

const pageRequestSchema = z
  .object({
    limit: nonNegativeInteger(LIMIT_MESSAGE)
      .pipe(z.number().min(1, { error: LIMIT_MESSAGE }).max(MAX_LIMIT, { error: LIMIT_MESSAGE }))
      .default(DEFAULT_LIMIT),
    offset: nonNegativeInteger(OFFSET_MESSAGE).default(0),
  })
  .transform(({ limit, offset }): ValidPageRequest => ({ kind: 'ValidPageRequest', page: { limit, offset } }));

// Every problem is reported, in the schema's key order (limit, then offset).
export const parsePageRequest = (query: { limit?: QueryValue; offset?: QueryValue }): ParsePageResult => {
  const result = pageRequestSchema.safeParse(query);
  return result.success
    ? result.data
    : { kind: 'InvalidPageRequest', message: result.error.issues.map((issue) => issue.message).join('; ') };
};
