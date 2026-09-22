# REST API Style

'REST' here means correct use of verbs, paths, and status codes — not HATEOAS.
This is a level 2 API in the [Richardson Maturity Model](https://martinfowler.com/articles/richardsonMaturityModel.html).

## Format

- JSON is the format of all resource and request bodies.
- Every route **must** carry a complete `@openapi` JSDoc block (summary, description, tags, parameters, request/response schemas, and an example) before it's considered done. `openapi-coverage.test.ts` fails the build on undocumented routes, and `openapi-conformance.test.ts` checks real responses against the documented schema — an endpoint without one isn't finished.

## Verbs

- **GET** — read a resource or a list. Never mutates state.
- **POST** — create a resource, or invoke an operation on an existing aggregate (see below). Returns `201` for a creation, `200` for an operation.
- **PATCH** — partial update of a resource. Returns `200` with the updated resource.
- **DELETE** — remove a resource. Returns `204` with no body.
- **PUT** is not used — it isn't backwards compatible with adding new properties to a resource.

## Aggregates and operations

In Domain Driven Design terms, an aggregate is the basic unit of a resource. When an aggregate has an operation that isn't a plain create/read/update/delete (e.g. `cancel`, `archive`, `approve`):

- Use **POST**.
- Path is the resource path followed by `/{operationName}`, e.g. `POST /orders/{id}/cancel`.
- Response is the JSON value of the aggregate after the operation, unless the endpoint's docs specify otherwise.
- Response status is `200`.

## Status codes

| Situation | Status |
|---|---|
| Successful GET | `200` |
| Successful POST (create) | `201` |
| Successful POST (operation) | `200` |
| Successful PATCH | `200` |
| Successful DELETE | `204`, no body |
| Client sent an invalid request | `400` |
| Resource doesn't exist | `404` |
| Request conflicts with current state | `409` |
| Request is well-formed but fails validation | `422` |
| Unhandled server error | `500` |

## Errors

Error responses use a consistent envelope, regardless of status code:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Order abc123 not found"
  }
}
```

- `code` is a stable, machine-readable, SCREAMING_SNAKE_CASE identifier clients can branch on. It does not change if the human-readable message is reworded.
- `message` is a human-readable description, safe to log and safe to show to a developer consuming the API. Never include stack traces or internal implementation detail.
- Document the possible `error.code` values for a route in its `@openapi` block, one per non-2xx response documented.

## Naming and casing

- **Paths**: plural nouns, `kebab-case` for multi-word segments. E.g. `/order-items`, not `/orderItem` or `/order_items`.
- **JSON fields**: `camelCase`, matching this repo's TypeScript conventions. E.g. `createdAt`, not `created_at`.
- **Resource IDs**: opaque strings (UUIDs or similar) in path parameters, not sequential integers — this avoids leaking internal counts and keeps IDs stable if storage changes.
- **Sub-resources**: nest under their parent when the child cannot meaningfully exist without it, e.g. `/orders/{id}/line-items/{lineItemId}`. Keep unrelated resources flat and top-level.

## Timestamps

All dates and times in request/response bodies are ISO 8601 strings in UTC, e.g. `"2026-09-22T10:00:00Z"`. Never use epoch numbers or local time without an offset.

## Lists and paging

Unless an endpoint's docs specify otherwise, GET paths that return a list must page results using `limit` and `offset` query parameters:

- `limit` — max items to return. Document a default and a max in the `@openapi` block.
- `offset` — number of items to skip.

The response body is wrapped, never a bare array:

```json
{
  "items": [ /* ... */ ],
  "total": 137
}
```

`total` is the total count of items matching the query, independent of `limit`/`offset`.

## Filtering and sorting

Where a list endpoint supports filtering or sorting, express it as plain query parameters:

- One query parameter per filterable field, matching the field's name in the resource body, e.g. `?status=active`.
- `sort` takes a field name, optionally prefixed with `-` for descending, e.g. `?sort=-createdAt`.

Don't invent filter/sort parameters speculatively — only add them to an endpoint's docs and implementation when something actually needs them.

## Authentication

Not yet defined — this repo has no authentication mechanism. Do not invent one; add this section once a real mechanism is chosen.

## Worked example: `widgets`

A resource named `widgets`, showing every route shape above together.

```
GET    /widgets                  list, paged
GET    /widgets/{id}             get one
POST   /widgets                  create
PATCH  /widgets/{id}             partial update
DELETE /widgets/{id}             delete
POST   /widgets/{id}/archive     aggregate operation
```

```ts
/**
 * @openapi
 * /widgets:
 *   get:
 *     summary: List widgets
 *     description: Returns a page of widgets, optionally filtered by status.
 *     tags: [Widgets]
 *     parameters:
 *       - name: limit
 *         in: query
 *         schema: { type: integer, default: 20, maximum: 100 }
 *       - name: offset
 *         in: query
 *         schema: { type: integer, default: 0 }
 *       - name: status
 *         in: query
 *         schema: { type: string, enum: [active, archived] }
 *       - name: sort
 *         in: query
 *         schema: { type: string, example: -createdAt }
 *     responses:
 *       200:
 *         description: A page of widgets.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Widget' }
 *                 total: { type: integer }
 *   post:
 *     summary: Create a widget
 *     tags: [Widgets]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/WidgetInput' }
 *     responses:
 *       201:
 *         description: The created widget.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Widget' }
 *       422:
 *         description: Validation failed.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *
 * /widgets/{id}:
 *   get:
 *     summary: Get a widget
 *     tags: [Widgets]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The requested widget.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Widget' }
 *       404:
 *         description: No widget with that id.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *   patch:
 *     summary: Update a widget
 *     tags: [Widgets]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/WidgetInput' }
 *     responses:
 *       200:
 *         description: The updated widget.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Widget' }
 *   delete:
 *     summary: Delete a widget
 *     tags: [Widgets]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204:
 *         description: Widget deleted.
 *
 * /widgets/{id}/archive:
 *   post:
 *     summary: Archive a widget
 *     description: Aggregate operation — moves a widget to the archived state.
 *     tags: [Widgets]
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The archived widget.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Widget' }
 */
router.get('/widgets', listWidgets);
router.post('/widgets', createWidget);
router.get('/widgets/:id', getWidget);
router.patch('/widgets/:id', updateWidget);
router.delete('/widgets/:id', deleteWidget);
router.post('/widgets/:id/archive', archiveWidget);
```
