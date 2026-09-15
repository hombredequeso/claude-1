#!/usr/bin/env node
// Parses an OpenAPI (JSON) document into a flat, structured list of operations,
// grouped by inferred resource, with a suggested execution order and a list of
// candidate "spec doesn't say what should happen" edge-case tests per operation.
//
// Usage: node list-endpoints.mjs <path-to-openapi.json> [--out=<path>]
//
// Deliberately dependency-free (no ajv / no $RefParser) so it runs unmodified
// in any project. $refs in requestBody/response schemas are left as pointer
// strings (schemaRef) rather than resolved here — resolution happens in
// validate-schema.mjs at validation time, against the actual response.

import { readFileSync, writeFileSync } from 'node:fs';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'];

const jsonPointerEscape = (segment) => segment.replace(/~/g, '~0').replace(/\//g, '~1');

// --- pure transforms -------------------------------------------------------

const firstStaticSegment = (path) => {
  const segment = path.split('/').find((s) => s.length > 0 && !s.startsWith('{'));
  return segment ?? path;
};

const resourceKeyFor = (path, operation) => operation.tags?.[0] ?? firstStaticSegment(path);

const hasPathParam = (path) => /\{[^}]+\}/.test(path);

const contentSchemaRefs = (content, basePointer) =>
  Object.entries(content ?? {}).map(([mediaType, mediaObj]) => ({
    contentType: mediaType,
    schemaRef: mediaObj?.schema ? `${basePointer}/content/${jsonPointerEscape(mediaType)}/schema` : undefined,
  }));

const buildRequestBody = (requestBody, opPointer) =>
  requestBody
    ? {
        required: requestBody.required ?? false,
        variants: contentSchemaRefs(requestBody.content, `${opPointer}/requestBody`),
      }
    : undefined;

const buildResponses = (responses, opPointer) =>
  Object.fromEntries(
    Object.entries(responses ?? {}).map(([status, responseObj]) => [
      status,
      {
        description: responseObj?.description,
        variants: contentSchemaRefs(responseObj?.content, `${opPointer}/responses/${status}`),
      },
    ]),
  );

const buildOperations = (spec) =>
  Object.entries(spec.paths ?? {}).flatMap(([path, pathItem]) => {
    const pathLevelParams = pathItem.parameters ?? [];
    return HTTP_METHODS.filter((m) => pathItem[m]).map((method) => {
      const operation = pathItem[method];
      const opPointer = `#/paths/${jsonPointerEscape(path)}/${method}`;
      const allDefinedMethods = HTTP_METHODS.filter((m) => pathItem[m]);
      return {
        method: method.toUpperCase(),
        path,
        operationId: operation.operationId,
        summary: operation.summary,
        resource: resourceKeyFor(path, operation),
        parameters: [...pathLevelParams, ...(operation.parameters ?? [])].map((p) => ({
          name: p.name,
          in: p.in,
          required: p.required ?? p.in === 'path',
          schema: p.schema,
        })),
        requestBody: buildRequestBody(operation.requestBody, opPointer),
        responses: buildResponses(operation.responses, opPointer),
        security: operation.security ?? spec.security ?? [],
        hasPathParam: hasPathParam(path),
        siblingMethodsOnPath: allDefinedMethods.map((m) => m.toUpperCase()),
      };
    });
  });

// Rough create -> read -> update -> delete ordering within a resource group,
// so a run that follows this order has a chance of GET-ing what POST made.
const ORDER_RANK = { POST: 0, GET: 1, PUT: 2, PATCH: 2, DELETE: 3, OPTIONS: 4, HEAD: 4, TRACE: 4 };
const rankFor = (op) => ORDER_RANK[op.method] ?? 5;

const groupByResource = (operations) =>
  Object.entries(
    operations.reduce((groups, op) => {
      const existing = groups[op.resource] ?? [];
      return { ...groups, [op.resource]: [...existing, op] };
    }, {}),
  ).map(([resource, ops]) => ({
    resource,
    suggestedOrder: [...ops].sort((a, b) => rankFor(a) - rankFor(b) || (a.hasPathParam ? 1 : -1) - (b.hasPathParam ? 1 : -1)),
  }));

const ALL_ROUTABLE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

const edgeCasesFor = (op) => {
  const cases = [];
  if (op.hasPathParam) {
    cases.push({
      type: 'not-found',
      description: `${op.method} ${op.path} with a well-formed but nonexistent id/slug`,
      expect: 'status 404 with a JSON error body; never 500 or 200',
    });
  }
  const requiredBodyFields = (op.requestBody?.variants ?? []).length > 0 ? 'requestBody' : undefined;
  if (op.requestBody?.required) {
    cases.push({
      type: 'missing-required-field',
      description: `${op.method} ${op.path} with a required requestBody field omitted`,
      expect: 'status 400 or 422 identifying the missing field; never 500 or a silent 2xx',
      note: requiredBodyFields
        ? 'resolve the requestBody schemaRef to find which fields are `required`'
        : undefined,
    });
  }
  const enumParams = op.parameters.filter((p) => p.schema?.enum);
  enumParams.forEach((p) => {
    cases.push({
      type: 'invalid-enum-value',
      description: `${op.method} ${op.path} with parameter "${p.name}" set to a value outside its enum`,
      expect: 'status 400 or 422; never 500',
    });
  });
  if (op.security.length > 0) {
    cases.push({
      type: 'unauthenticated',
      description: `${op.method} ${op.path} with no credentials`,
      expect: 'status 401 or 403; never 200 or 500',
    });
  }
  const undocumentedMethods = ALL_ROUTABLE_METHODS.filter((m) => !op.siblingMethodsOnPath.includes(m));
  if (undocumentedMethods.length > 0) {
    cases.push({
      type: 'undocumented-method',
      description: `${undocumentedMethods.join('/')} ${op.path} (only ${op.siblingMethodsOnPath.join('/')} is documented on this path)`,
      expect: 'status 404 or 405; never 200 or 500',
    });
  }
  return cases;
};

const buildReport = (spec) => {
  const operations = buildOperations(spec).map((op) => ({ ...op, edgeCases: edgeCasesFor(op) }));
  return {
    info: { title: spec.info?.title, version: spec.info?.version },
    servers: spec.servers ?? [],
    operationCount: operations.length,
    resourceGroups: groupByResource(operations),
    operations,
  };
};

// --- effectful shell (I/O only) ---------------------------------------------

const main = () => {
  const [, , specPath, ...rest] = process.argv;
  if (!specPath) {
    console.error('Usage: node list-endpoints.mjs <path-to-openapi.json> [--out=<path>]');
    process.exit(2);
  }
  const outFlag = rest.find((a) => a.startsWith('--out='));
  const outPath = outFlag?.slice('--out='.length);

  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  if (!spec.openapi && !spec.swagger) {
    console.error(`Warning: ${specPath} has no "openapi"/"swagger" field — is this an OpenAPI document?`);
  }
  const report = buildReport(spec);
  const output = JSON.stringify(report, null, 2);

  if (outPath) {
    writeFileSync(outPath, output);
    console.log(`Wrote ${report.operationCount} operations across ${report.resourceGroups.length} resource groups to ${outPath}`);
  } else {
    console.log(output);
  }
};

main();
