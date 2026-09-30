/**
 * @openapi
 * components:
 *   schemas:
 *     Error:
 *       type: object
 *       required: [error]
 *       additionalProperties: false
 *       properties:
 *         error:
 *           type: object
 *           required: [code, message]
 *           additionalProperties: false
 *           properties:
 *             code:
 *               type: string
 *               description: Stable, machine-readable error identifier.
 *               example: NOT_FOUND
 *             message:
 *               type: string
 *               description: Human-readable description of the error.
 *               example: Order 3f2b8c1e-9a4d-4e7f-b6a1-2c5d8e9f0a1b not found
 */
export type ErrorResponse = {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
};

export const errorResponse = (code: string, message: string): ErrorResponse => ({
  error: { code, message },
});
