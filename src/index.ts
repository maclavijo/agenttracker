import { parseTokenDirectory } from './auth.js';
import { buildApp } from './app.js';
import { databaseUrl, serverPort } from './config.js';
import { createDatabase } from './db/client.js';

const tokens = parseTokenDirectory();

if (tokens.size === 0) {
  console.warn(
    'No bearer tokens configured (AGENT_TOKENS, HUMAN_TOKENS); write requests will be rejected with 401.',
  );
}

const database = createDatabase(databaseUrl());
const app = buildApp(
  { db: database.db, ping: () => database.ping(), tokens },
  { logger: true },
);

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
