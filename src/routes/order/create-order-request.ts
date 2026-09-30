import { z } from 'zod';

type ValidCreateOrderRequest = {
  readonly kind: 'ValidCreateOrderRequest';
  readonly id: string;
  readonly description: string;
};

// The body isn't shaped like a create-order request at all (400).
type MalformedCreateOrderRequest = {
  readonly kind: 'MalformedCreateOrderRequest';
  readonly message: string;
};

// The body is well-formed but its values are unacceptable (422).
type InvalidCreateOrderRequest = {
  readonly kind: 'InvalidCreateOrderRequest';
  readonly message: string;
};

export type ParseCreateOrderRequestResult =
  | ValidCreateOrderRequest
  | MalformedCreateOrderRequest
  | InvalidCreateOrderRequest;

const createOrderRequestSchema = z
  .object(
    {
      id: z.string({ error: 'id is required and must be a string' }).pipe(z.guid({ error: 'id must be a GUID' })),
      description: z.string({ error: 'description is required and must be a string' }),
    },
    { error: 'Request body must be a JSON object' }
  )
  .transform(
    ({ id, description }): ValidCreateOrderRequest => ({ kind: 'ValidCreateOrderRequest', id, description })
  );

// A GUID format failure is the only unacceptable-value (422) case. Any other
// issue means the body is malformed (400), and that takes precedence.
export const parseCreateOrderRequest = (body: unknown): ParseCreateOrderRequestResult => {
  const result = createOrderRequestSchema.safeParse(body);
  if (result.success) {
    return result.data;
  }
  const { issues } = result.error;
  const malformation = issues.find((issue) => issue.code !== 'invalid_format');
  return malformation !== undefined
    ? { kind: 'MalformedCreateOrderRequest', message: malformation.message }
    : { kind: 'InvalidCreateOrderRequest', message: issues.map((issue) => issue.message).join('; ') };
};
