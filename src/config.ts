export const DEFAULT_PORT = 3000;

export const DEFAULT_DATABASE_URL =
  'postgres://agenttracker:agenttracker@localhost:5438/agenttracker';

export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}

export function serverPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PORT;

  if (raw === undefined || raw === '') {
    return DEFAULT_PORT;
  }

  const port = Number(raw);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, received "${raw}"`);
  }

  return port;
}
