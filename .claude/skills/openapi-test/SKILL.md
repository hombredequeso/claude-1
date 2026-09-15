---
name: openapi-test
description: Test that a running API actually matches its OpenAPI spec — request/response conformance (status codes, schemas, content types), inferred create-then-read/update/delete sequences, and behavior the spec leaves unspecified (404s, auth failures, invalid input, undocumented methods). Given a path to an openapi.json and a host[:port], drives real HTTP requests against the live API. Spec-agnostic: works from any OpenAPI 3.x document, not tied to any particular API.
disable-model-invocation: true
allowed-tools: Bash, Read, Write, Glob
---

# OpenAPI Conformance Test

Given an `openapi.json` and a `host[:port]` of a running instance of that API,
drive real requests at it and report where the live API disagrees with its
own spec — plus places the spec is silent but the API still did something
unacceptable (500s, silent data corruption, no error body, etc).

## Usage

```
/openapi-test <path-to-openapi.json> <host[:port]> [base-path]
```

Example: `/openapi-test ./openapi.json localhost:3000`

## Safety first — read before sending anything

This skill sends real, possibly mutating (`POST`/`PUT`/`PATCH`/`DELETE`)
requests to the target host and creates/modifies/deletes real data there.

- If the host is not `localhost`/`127.0.0.1`/a name that obviously reads as
  local/dev/staging, **stop and confirm with the user** before sending any
  mutating request. State plainly that this will create and delete data.
- Even on localhost, if a `DELETE` operation exists for a resource this run
  did **not** create, don't call it — only clean up what this run created.
- If the spec's `servers[]` or the user-supplied host implies an environment
  you can't identify as disposable, ask rather than assume.

## Step-by-step procedure

### 1. Resolve inputs

- Confirm the spec file exists and parses as JSON with an `openapi` (or
  `swagger`) field. If it's YAML, ask the user to point you at (or generate)
  a JSON version — the helper scripts below only read JSON.
- Build the base URL from the user-supplied `host[:port]` plus the path
  portion of `servers[0].url` in the spec, if any (scheme: `http` unless the
  spec or user says otherwise).

### 2. Parse & summarize the spec — don't do this by hand

```
node .claude/skills/openapi-test/scripts/list-endpoints.mjs <spec> --out=<scratch>/endpoints.json
```

Read `<scratch>/endpoints.json`. It's the authoritative map of the spec for
the rest of this run:

- `operations[]` — one entry per method+path, with parameters, a
  `requestBody`/`responses` map of *pointers* to their schemas (not the
  schemas inlined — resolve them with `validate-schema.mjs` in step 5), which
  security requirements apply, and which HTTP methods are/aren't documented
  on that path.
- `resourceGroups[]` — operations grouped by tag (or first path segment) with
  a `suggestedOrder` (create → read → update → delete) for that group.
- `operations[].edgeCases[]` — candidate "spec doesn't say" tests per
  operation (see step 6), each with a spec-agnostic expectation.

Don't re-derive any of this by re-reading the raw spec JSON yourself — for
anything beyond a handful of endpoints, hand-parsing invites the exact
mistakes (missed `$ref`, wrong pointer, missed required field) this script
exists to avoid.

### 3. Plan the run

For each resource group, follow `suggestedOrder` so state from one call can
feed the next:

- After a `POST` (create) that returns `201`/`200`, pull the id/slug out of
  the response body and substitute it for `{id}`-style path params in that
  resource's later `GET`/`PUT`/`PATCH`/`DELETE` calls.
- Keep a small fixture map (`resource -> last created value`) for this.
- If a dependency isn't obvious from matching path params / resource names
  (e.g. an order references a customer from a different resource group),
  either create the prerequisite first or skip the dependent test and say so
  in the report — don't guess at cross-resource relationships the spec
  doesn't express.

Build request data (path/query params, request bodies) from the schema:

1. Prefer a literal `example`/`examples` on the parameter or media-type
   object if the spec has one.
2. Otherwise synthesize the minimal valid instance from the schema (see
   "Synthesizing request data" below).

### 4. Execute

For each planned call, issue the actual request (`curl -sS -o <scratch>/body.json -w '%{http_code}' -D <scratch>/headers.txt ...`, or a one-off Node
snippet with `fetch` if that's easier for auth headers/retries) and keep:
method, URL, request body sent, status code, response headers, response body.

### 5. Validate the response

- **Status code**: is it one of the codes documented for this operation? An
  undocumented `5xx` is always a hard failure regardless of what's written in
  the spec.
- **Schema**: for a JSON response, resolve the matching `responses[status].variants[].schemaRef`
  from `endpoints.json` for the actual status/content-type received, then:
  ```
  node .claude/skills/openapi-test/scripts/validate-schema.mjs <spec> '<schemaRef>' <scratch>/body.json
  ```
  Report every violation line it prints — don't eyeball schema conformance
  by hand for anything with nested objects/arrays/`oneOf`.
- **Content-Type**: does the response header match one of the response's
  documented content types?

### 6. Run the "spec doesn't say" tests

For every entry in `operations[].edgeCases[]`, actually execute it (don't
just report the suggestion) and judge the result against that entry's
`expect` line. These expectations are general HTTP/API hygiene, not derived
from this particular spec:

| type | send | never acceptable |
|---|---|---|
| `not-found` | a well-formed but nonexistent id/slug | `500`, or a `200` with no matching resource |
| `missing-required-field` | request body with a required field omitted | `500`, or a silent `2xx` that ignores the missing field |
| `invalid-enum-value` | a value outside the declared enum | `500` |
| `unauthenticated` | the request with no credentials | `200`, `500` |
| `undocumented-method` | a method not documented on that path | `200`, `500` |

Also worth probing even where `list-endpoints.mjs` doesn't suggest it:
malformed/unparseable JSON body (expect `400`, never `500`), and wrong
`Content-Type` on a request (expect `400`/`415`, never `500`).

A `500`, a hang, or a response that contradicts the "never" column is a hard
**failure**. A response that doesn't hit the "expect" column but also isn't a
hard failure (e.g. `403` instead of `401`, or `200` with an empty list
instead of `404`) is a **spec gap** — the behavior may be fine, but the spec
should say so and currently doesn't.

### 7. Clean up

For any resource this run created, call its documented `DELETE` (if one
exists) so the run doesn't leave junk behind. Note in the report anything
that couldn't be cleaned up and why (no `DELETE` documented, or it failed).

### 8. Report

Produce a markdown report with these sections:

1. **Coverage** — operations exercised vs. total, and which were skipped and
   why (e.g. no safe way to synthesize data, no reachable dependency).
2. **Conformance failures** — spec says X, API did Y. One line each:
   method+path, expected (status/schema), actual, and the specific
   violation. Include just enough of the request/response to reproduce it.
3. **Spec gaps** — behavior the spec doesn't pin down, observed during
   testing, worth documenting (e.g. "GET /widgets/{id} for a missing id
   returns 404 with no body — spec doesn't define an error schema").
4. **Judgment calls / assumptions** — sequencing choices, synthesized data,
   anything skipped and why, anything ambiguous in the spec that was
   resolved by guessing.

## Synthesizing request data (when no example is present)

- `string`: `"test-string"`, unless `format` implies something specific —
  `uuid` → a real random UUIDv4, `date-time`/`date` → current time in that
  format, `email` → `"test@example.com"`.
- `integer`/`number`: `minimum` if present, else `1`; stay under `maximum`.
- `boolean`: `true`.
- `array`: one element built from `items`.
- `object`: fill `required` properties recursively; leave optional ones out
  unless a test specifically calls for a fuller payload.
- `enum`: the first listed value.

Keep synthesized values obviously synthetic (`"test-string"`, not a
plausible-looking real name/email/address) — this is exercising plumbing,
not producing realistic fixtures.

## Limitations (tell the user, don't silently paper over these)

- `validate-schema.mjs` resolves only internal `$ref`s and ignores sibling
  keywords next to a `$ref` (pre-3.1 behavior) — a schema mixing `$ref` with
  sibling keywords under 3.1 semantics won't get the sibling keywords
  checked.
- `format` checks are best-effort for `uuid`/`date`/`date-time`/`email` only;
  other formats are accepted without validation.
- No support for `discriminator`, `patternProperties`, tuple-style `items`
  arrays, or external/remote `$ref`s.
- Multi-step business-logic correctness (not just contract conformance) is
  inherently spec-dependent — this skill tests what the spec commits to, not
  business rules the spec doesn't encode.

---

## Reference material (not part of the skill — context that would make runs more reliable)

This skill is intentionally spec-agnostic and doesn't assume anything about a
particular API's conventions. Results would be materially more reliable with
project-specific answers to:

- **ID/slug format** — UUID vs. incrementing integer vs. custom slug — so
  "nonexistent id" probes are well-formed instead of failing for the wrong
  reason (e.g. a `400` for a malformed id being mistaken for the `404` test).
- **Auth** — how to obtain a valid test credential/token beyond what
  `securitySchemes` declares (most specs document the scheme shape, not how
  to mint a usable token for testing).
- **Environment safety** — confirmation that the target host's data is
  disposable, and how to reset/reseed it if a run needs to be re-run.
- **Pagination conventions**, if the spec's schema alone doesn't make the
  list-endpoint contract clear (cursor vs. offset, response envelope shape).
- **Standard error envelope**, so error responses (400/404/etc.) can be
  schema-validated too, not just status-code-checked.
- **Known, intentional gaps** — behavior that's deliberately undocumented so
  it isn't misreported as a spec gap.
- **Rate limits / concurrency constraints** that would make a full sequential
  run unsafe or need pacing.
