#!/usr/bin/env node
// Validates a JSON value against a JSON Schema found at a given JSON Pointer
// inside an OpenAPI (JSON) document. Supports the common OpenAPI 3.0/3.1
// subset: type (incl. arrays / nullable), enum, required, properties,
// additionalProperties, items, min/max(Length/Items), exclusiveMin/Max,
// pattern, a best-effort check for a handful of `format`s, and
// oneOf/anyOf/allOf. Internal $refs only (e.g. #/components/schemas/Widget) —
// no remote/file refs, no dependency on ajv or any other package.
//
// Usage: node validate-schema.mjs <spec.json> <#/json/pointer/to/schema> <response.json|->
// Exit code 0 = valid, 1 = violations found, 2 = usage/parse error.

import { readFileSync } from 'node:fs';

const REF_DEPTH_LIMIT = 30;

// --- pure schema resolution & validation ------------------------------------

const resolvePointer = (spec, pointer) => {
  if (!pointer.startsWith('#/')) throw new Error(`Only internal pointers are supported, got: ${pointer}`);
  const segments = pointer
    .slice(2)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  const resolved = segments.reduce((node, seg) => node?.[seg], spec);
  if (resolved === undefined) throw new Error(`Pointer not found in spec: ${pointer}`);
  return resolved;
};

const resolveSchema = (spec, schema, depth = 0) => {
  if (depth > REF_DEPTH_LIMIT) return schema; // cycle guard
  if (schema?.$ref) return resolveSchema(spec, resolvePointer(spec, schema.$ref), depth + 1);
  return schema;
};

const typeOf = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value; // 'string' | 'boolean' | 'object' | 'undefined'
};

const satisfiesDeclaredType = (declared, actual) =>
  declared === actual || (declared === 'number' && actual === 'integer');

const FORMAT_CHECKS = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
};

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const validate = (spec, rawSchema, value, path = '$', depth = 0) => {
  const schema = resolveSchema(spec, rawSchema, depth);
  if (schema === undefined || schema === true) return [];
  if (schema === false) return [`${path}: value not allowed (schema is \`false\`)`];

  const violations = [];
  const actual = typeOf(value);
  const nullable = schema.nullable === true; // OpenAPI 3.0 style

  const declaredTypes = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (declaredTypes.length > 0 && !(value === null && nullable)) {
    const ok = declaredTypes.some((t) => satisfiesDeclaredType(t, actual));
    if (!ok) violations.push(`${path}: expected type ${declaredTypes.join('|')}, got ${actual}`);
  }

  if (schema.enum && !schema.enum.some((e) => deepEqual(e, value))) {
    violations.push(`${path}: value not in enum [${schema.enum.map((e) => JSON.stringify(e)).join(', ')}]`);
  }

  if (schema.format && FORMAT_CHECKS[schema.format] && actual === 'string') {
    if (!FORMAT_CHECKS[schema.format].test(value)) {
      violations.push(`${path}: does not match format "${schema.format}"`);
    }
  }

  if (actual === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) violations.push(`${path}: shorter than minLength ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) violations.push(`${path}: longer than maxLength ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) violations.push(`${path}: does not match pattern ${schema.pattern}`);
  }

  if (actual === 'number' || actual === 'integer') {
    if (schema.minimum !== undefined && value < schema.minimum) violations.push(`${path}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) violations.push(`${path}: above maximum ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) violations.push(`${path}: not above exclusiveMinimum ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) violations.push(`${path}: not below exclusiveMaximum ${schema.exclusiveMaximum}`);
  }

  if (actual === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) violations.push(`${path}: fewer than minItems ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) violations.push(`${path}: more than maxItems ${schema.maxItems}`);
    if (schema.items) {
      violations.push(...value.flatMap((item, i) => validate(spec, schema.items, item, `${path}[${i}]`, depth + 1)));
    }
  }

  if (actual === 'object') {
    const properties = schema.properties ?? {};
    violations.push(
      ...(schema.required ?? [])
        .filter((key) => !(key in value))
        .map((key) => `${path}: missing required property "${key}"`),
    );
    violations.push(
      ...Object.entries(value)
        .filter(([key]) => key in properties)
        .flatMap(([key, v]) => validate(spec, properties[key], v, `${path}.${key}`, depth + 1)),
    );
    if (schema.additionalProperties === false) {
      violations.push(
        ...Object.keys(value)
          .filter((key) => !(key in properties))
          .map((key) => `${path}: unexpected additional property "${key}"`),
      );
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      violations.push(
        ...Object.entries(value)
          .filter(([key]) => !(key in properties))
          .flatMap(([key, v]) => validate(spec, schema.additionalProperties, v, `${path}.${key}`, depth + 1)),
      );
    }
  }

  if (schema.allOf) violations.push(...schema.allOf.flatMap((s) => validate(spec, s, value, path, depth + 1)));

  if (schema.anyOf) {
    const results = schema.anyOf.map((s) => validate(spec, s, value, path, depth + 1));
    if (!results.some((r) => r.length === 0)) {
      violations.push(`${path}: matched none of ${results.length} anyOf schemas (e.g. ${results[0]?.[0] ?? 'no detail'})`);
    }
  }

  if (schema.oneOf) {
    const results = schema.oneOf.map((s) => validate(spec, s, value, path, depth + 1));
    const passing = results.filter((r) => r.length === 0).length;
    if (passing !== 1) {
      violations.push(`${path}: matched ${passing} of ${results.length} oneOf schemas (exactly 1 required)`);
    }
  }

  return violations;
};

// --- effectful shell (I/O only) ---------------------------------------------

const readValueArg = (arg) => JSON.parse(arg === '-' ? readFileSync(0, 'utf8') : readFileSync(arg, 'utf8'));

const main = () => {
  const [, , specPath, pointer, valueArg] = process.argv;
  if (!specPath || !pointer || !valueArg) {
    console.error('Usage: node validate-schema.mjs <spec.json> <#/json/pointer/to/schema> <response.json|->');
    process.exit(2);
  }

  let spec, value;
  try {
    spec = JSON.parse(readFileSync(specPath, 'utf8'));
    value = readValueArg(valueArg);
  } catch (err) {
    console.error(`Failed to read/parse input: ${err.message}`);
    process.exit(2);
  }

  let schema;
  try {
    schema = resolvePointer(spec, pointer);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  const violations = validate(spec, schema, value);
  if (violations.length === 0) {
    console.log('PASS');
    process.exit(0);
  }
  console.log(`FAIL (${violations.length} violation${violations.length === 1 ? '' : 's'}):`);
  violations.forEach((v) => console.log(`  - ${v}`));
  process.exit(1);
};

main();
