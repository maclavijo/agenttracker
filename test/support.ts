import { sql } from 'drizzle-orm';
import type { TokenDirectory } from '../src/auth.js';
import type { Database } from '../src/db/client.js';

export const AGENT_TOKEN = 'test-agent-token';
export const HUMAN_TOKEN = 'test-human-token';
export const AGENT_ACTOR_ID = 'test-agent';
export const HUMAN_ACTOR_ID = 'test-human';

export const testTokens: TokenDirectory = new Map([
  [AGENT_TOKEN, { actorType: 'agent', actorId: AGENT_ACTOR_ID }],
  [HUMAN_TOKEN, { actorType: 'human', actorId: HUMAN_ACTOR_ID }],
]);

export function bearerAuthorization(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/** Resets both tables so each test starts from an empty log and projection. */
export async function truncateAll(db: Database): Promise<void> {
  await db.execute(sql`TRUNCATE TABLE events, issues RESTART IDENTITY CASCADE`);
}
