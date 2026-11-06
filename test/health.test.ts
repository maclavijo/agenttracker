import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { databaseUrl } from '../src/config.js';
import { createDatabase } from '../src/db/client.js';

describe('GET /health', () => {
  const database = createDatabase(databaseUrl());
  const app = buildApp({ db: database.db, ping: () => database.ping() });

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it('reports that the database is up when a real query succeeds', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, db: 'up' });
  });
});

describe('GET /health when the database is unavailable', () => {
  const database = createDatabase(databaseUrl());
  const app = buildApp({
    db: database.db,
    ping: async () => {
      throw new Error('database is unavailable');
    },
  });

  beforeAll(async () => {
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it('responds with 503 and reports that the database is down', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false, db: 'down' });
  });
});
