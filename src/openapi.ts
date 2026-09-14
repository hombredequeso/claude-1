import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import swaggerJsdoc from 'swagger-jsdoc';

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);
const sourceExtension = currentFile.endsWith('.ts') ? 'ts' : 'js';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'claude-1 API',
      version: '1.0.0',
    },
  },
  apis: [join(currentDir, `**/*.${sourceExtension}`)],
};

export const openApiSpec = swaggerJsdoc(options) as swaggerJsdoc.OAS3Definition;
