import { createApp } from '../src/app.ts';

const startServer = () => {
  const app = createApp();
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, port };
};

const main = async () => {
  const { server, port } = startServer();
  console.log(`running on ${port}`);

  const res = await fetch(`http://localhost:${port}/health`);
  const resBody = await res.text();
  console.log(res.status, resBody);

  server.close();
};

await main();
