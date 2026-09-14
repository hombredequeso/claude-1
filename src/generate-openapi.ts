import { writeFileSync } from 'node:fs';
import { openApiSpec } from './openapi.js';

writeFileSync('openapi.json', `${JSON.stringify(openApiSpec, null, 2)}\n`);
console.log('Wrote openapi.json');
