import { sql } from 'drizzle-orm';
import type { Database } from '../src/db/client.js';

/** Resets both tables so each test starts from an empty log and projection. */
export async function truncateAll(db: Database): Promise<void> {
  await db.execute(sql`TRUNCATE TABLE events, issues RESTART IDENTITY CASCADE`);
}
