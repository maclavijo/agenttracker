import { count, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { databaseUrl } from '../src/config.js';
import type { Database } from '../src/db/client.js';
import { createDatabase } from '../src/db/client.js';
import { issues } from '../src/db/schema.js';
import { truncateAll } from './support.js';

const SEEDED_ISSUES = 10_000;
const P95_TARGET_MS = 50;
const SAMPLES = 200;
const WARMUPS = 20;

interface IssuePageJson {
  issues: { key: number }[];
  nextCursor: string | null;
}

const database = createDatabase(databaseUrl());
const app = buildApp({ db: database.db, ping: () => database.ping() });

beforeAll(async () => {
  await app.ready();
  await truncateAll(database.db);
  await seedBenchmarkData(database.db);
});

afterAll(async () => {
  await truncateAll(database.db);
  await app.close();
  await database.close();
});

describe('GET /issues?limit=50 benchmark', () => {
  it('serves the newest page under the SPEC p95 target on 10,000 issues', async () => {
    const [seeded] = await database.db.select({ total: count() }).from(issues);

    expect(seeded?.total).toBe(SEEDED_ISSUES);

    for (let index = 0; index < WARMUPS; index += 1) {
      const warmup = await app.inject({ method: 'GET', url: '/issues?limit=50' });
      expect(warmup.statusCode).toBe(200);
    }

    const samples: number[] = [];
    let lastPage: IssuePageJson | null = null;

    for (let index = 0; index < SAMPLES; index += 1) {
      const startedAt = performance.now();
      const response = await app.inject({ method: 'GET', url: '/issues?limit=50' });
      samples.push(performance.now() - startedAt);

      expect(response.statusCode).toBe(200);
      lastPage = response.json() as IssuePageJson;
    }

    samples.sort((left, right) => left - right);

    const p95 = samples[Math.ceil(samples.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;

    expect(p95).toBeLessThan(P95_TARGET_MS);
    expect(lastPage?.issues).toHaveLength(50);
    expect(lastPage?.issues[0]?.key).toBe(SEEDED_ISSUES);
    expect(lastPage?.issues.at(-1)?.key).toBe(SEEDED_ISSUES - 49);
    expect(lastPage?.nextCursor).not.toBeNull();
  }, 60_000);
});

/**
 * Seeds 10,000 issues the way the product would have: a bulk event insert and a
 * bulk projection insert, both in set-based SQL, with varied realistic fields.
 */
async function seedBenchmarkData(db: Database): Promise<void> {
  await db.execute(sql`
    INSERT INTO events (at, actor_type, actor_id, entity_type, entity_id, type, payload, seq)
    SELECT
      now() - (${SEEDED_ISSUES} - g) * interval '1 second',
      'agent',
      'seed-agent',
      'issue',
      'seed-issue-' || g,
      'issue.created',
      jsonb_build_object(
        'issue',
        jsonb_build_object(
          'id', 'seed-issue-' || g,
          'key', g,
          'title', 'Seeded issue ' || g,
          'body', 'Seeded body for issue ' || g,
          'status', (ARRAY['backlog', 'todo', 'in_progress', 'done', 'canceled'])[1 + (g % 5)],
          'priority', g % 5,
          'assignee', CASE WHEN g % 3 = 0 THEN NULL ELSE 'agent-' || (g % 50) END,
          'createdAt', to_char(
            now() - (${SEEDED_ISSUES} - g) * interval '1 second',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          ),
          'updatedAt', to_char(
            now() - (${SEEDED_ISSUES} - g) * interval '1 second',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          )
        )
      ),
      g
    FROM generate_series(1, ${SEEDED_ISSUES}) AS g
  `);

  await db.execute(sql`
    INSERT INTO issues (
      id, key, title, body, status, priority, assignee, created_at, updated_at, last_event_seq
    )
    SELECT
      'seed-issue-' || g,
      g,
      'Seeded issue ' || g,
      'Seeded body for issue ' || g,
      (ARRAY['backlog', 'todo', 'in_progress', 'done', 'canceled'])[1 + (g % 5)],
      g % 5,
      CASE WHEN g % 3 = 0 THEN NULL ELSE 'agent-' || (g % 50) END,
      now() - (${SEEDED_ISSUES} - g) * interval '1 second',
      now() - (${SEEDED_ISSUES} - g) * interval '1 second',
      g
    FROM generate_series(1, ${SEEDED_ISSUES}) AS g
  `);

  await db.execute(
    sql`SELECT setval(pg_get_serial_sequence('events', 'seq')::regclass, ${SEEDED_ISSUES}, true)`,
  );
  await db.execute(
    sql`SELECT setval(pg_get_serial_sequence('issues', 'key')::regclass, ${SEEDED_ISSUES}, true)`,
  );
}
