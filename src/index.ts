import { buildApp } from './app.js';
import { databaseUrl, serverPort } from './config.js';
import { createDatabase } from './db/client.js';

const database = createDatabase(databaseUrl());
const app = buildApp({ ping: () => database.ping() }, { logger: true });

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await database.close();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

try {
  await app.listen({ port: serverPort(), host: '0.0.0.0' });
} catch (error) {
  app.log.error(error);
  await database.close();
  process.exitCode = 1;
}
