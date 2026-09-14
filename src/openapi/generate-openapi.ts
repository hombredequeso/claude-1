import { mkdirSync, writeFileSync } from 'node:fs';
import { openApiSpec } from './openapi.js';

mkdirSync('openapi', { recursive: true });
writeFileSync('openapi/openapi.json', `${JSON.stringify(openApiSpec, null, 2)}\n`);
console.log('Wrote openapi/openapi.json');
