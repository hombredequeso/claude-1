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
