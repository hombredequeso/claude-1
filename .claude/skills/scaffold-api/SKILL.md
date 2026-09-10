---
name: scaffold-api
description: Scaffold a new Koa + TypeScript API project in the current directory, with pnpm, ESM, vitest, a GET /health endpoint, and a unit test for it.
disable-model-invocation: true
allowed-tools: Bash, Write
---

# Scaffold API Project

Scaffolds a Koa API in TypeScript into the **current directory**, using pnpm and ESM modules, vitest for testing, a `GET /health` endpoint that returns `200 "ok"`, and a supertest-based unit test for it.

## Steps

1. **Safety check.** If `package.json` already exists in the current directory, stop and ask the user how to proceed instead of overwriting anything.

2. **Init the project.**
   - `pnpm init`
   - Set `"type": "module"` in `package.json`.
   - Add scripts:
     - `"dev": "tsx watch src/server.ts"`
     - `"build": "tsc"`
     - `"start": "node dist/server.js"`
     - `"test": "vitest run"`

3. **Install dependencies.**
   - Runtime: `pnpm add koa`
   - Dev: `pnpm add -D typescript tsx @types/node @types/koa vitest supertest @types/supertest`

4. **Add `tsconfig.json`:**
   ```json
   {
     "compilerOptions": {
       "target": "ES2022",
       "module": "NodeNext",
       "moduleResolution": "NodeNext",
       "outDir": "dist",
       "rootDir": "src",
       "strict": true,
       "esModuleInterop": true,
       "skipLibCheck": true,
       "declaration": false
     },
     "include": ["src"]
   }
   ```

5. **Create `src/app.ts`** — builds and exports the Koa app. No side effects (does not call `.listen()`), so it stays testable in isolation:
   ```ts
   import Koa from 'koa';

   export const createApp = () => {
     const app = new Koa();

     app.use(async (ctx, next) => {
       if (ctx.path === '/health' && ctx.method === 'GET') {
         ctx.status = 200;
         ctx.body = 'ok';
         return;
       }
       await next();
     });

     return app;
   };
   ```

6. **Create `src/server.ts`** — the effectful entry point that starts listening, kept separate from app construction:
   ```ts
   import { createApp } from './app.js';

   const port = process.env.PORT ? Number(process.env.PORT) : 3000;

   createApp().listen(port, () => {
     console.log(`Server listening on port ${port}`);
   });
   ```

7. **Create `src/health.test.ts`:**
   ```ts
   import { describe, it, expect } from 'vitest';
   import request from 'supertest';
   import { createApp } from './app.js';

   describe('GET /health', () => {
     it('returns 200 "ok"', async () => {
       const response = await request(createApp().callback()).get('/health');

       expect(response.status).toBe(200);
       expect(response.text).toBe('ok');
     });
   });
   ```

8. **Verify.** Run `pnpm test` and confirm the health test passes.

## Notes

- Follows this repo's functional style guide (`docs/STYLE.md`): arrow functions throughout, and pure app construction (`createApp`) kept separate from the effectful `listen()` call in `server.ts`.
- This skill is manual-invocation only (`disable-model-invocation: true`) — it won't auto-trigger from casual mentions of "koa" or "api", only when explicitly run via `/scaffold-api`.
