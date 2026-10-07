import { createApp } from './app.js';

const port = process.env.PORT ? Number(process.env.PORT) : 3000;

const server = createApp().listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

// Exit normally on SIGTERM/SIGINT rather than being killed by the signal, so
// anything that runs on exit gets to run — e.g. node's --cpu-prof, which only
// writes its profile when the process exits normally.
const shutdown = (signal: NodeJS.Signals) => {
  console.log(`Received ${signal}, shutting down`);
  server.close(() => process.exit(0));
};

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
