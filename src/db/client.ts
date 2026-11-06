import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseConnection {
  readonly db: Database;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function createDatabase(connectionString: string): DatabaseConnection {
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5_000,
  });

  pool.on('error', (error) => {
    console.error('Unexpected error on idle Postgres client', error);
  });

  const db = drizzle(pool, { schema });

  return {
    db,
    async ping() {
      await pool.query('SELECT 1');
    },
    async close() {
      await pool.end();
    },
  };
}
