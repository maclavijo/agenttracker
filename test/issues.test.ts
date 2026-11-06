import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { databaseUrl } from '../src/config.js';
import { createDatabase } from '../src/db/client.js';
import { appendEvent } from '../src/events.js';
import { rebuildProjections } from '../src/issues/rebuild.js';
import { truncateAll } from './support.js';

interface IssueJson {
  id: string;
  key: number;
  title: string;
  body: string;
  status: string;
  priority: number;
  assignee: string | null;
  createdAt: string;
  updatedAt: string;
  lastEventSeq: number;
}

interface IssueEventJson {
  id: number;
  at: string;
  actorType: string;
  actorId: string;
  entityType: string;
  entityId: string;
  type: string;
  payload: { issue?: IssueSnapshotJson; [key: string]: unknown };
  seq: number;
}

interface IssueSnapshotJson {
  id: string;
  key: number;
  title: string;
  body: string;
  status: string;
  priority: number;
  assignee: string | null;
  createdAt: string;
  updatedAt: string;
}

interface IssuePageJson {
  issues: IssueJson[];
  nextCursor: string | null;
}

interface CreateBody {
  title: string;
  body?: string;
  status?: string;
  priority?: number;
  assignee?: string | null;
}

const database = createDatabase(databaseUrl());
const app = buildApp({ db: database.db, ping: () => database.ping() });

beforeAll(async () => {
  await app.ready();
});

beforeEach(async () => {
  await truncateAll(database.db);
});

afterAll(async () => {
  await truncateAll(database.db);
  await app.close();
  await database.close();
});

async function createIssue(overrides: Partial<CreateBody> = {}): Promise<IssueJson> {
  const response = await app.inject({
    method: 'POST',
    url: '/issues',
    payload: { title: 'A test issue', ...overrides },
  });

  expect(response.statusCode).toBe(201);

  return response.json() as IssueJson;
}

async function listPage(query: string): Promise<IssuePageJson> {
  const response = await app.inject({ method: 'GET', url: `/issues?${query}` });

  expect(response.statusCode).toBe(200);

  return response.json() as IssuePageJson;
}

describe('POST /issues', () => {
  it('creates the projection row and appends issue.created consistently', async () => {
    const issue = await createIssue({
      title: 'Fix login redirect',
      body: 'After a password reset the browser lands on a 404.',
      status: 'todo',
      priority: 2,
      assignee: 'agent-7',
    });

    expect(issue.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(issue.key).toBe(1);
    expect(issue.title).toBe('Fix login redirect');
    expect(issue.body).toBe('After a password reset the browser lands on a 404.');
    expect(issue.status).toBe('todo');
    expect(issue.priority).toBe(2);
    expect(issue.assignee).toBe('agent-7');
    expect(issue.lastEventSeq).toBe(1);

    const read = await app.inject({ method: 'GET', url: `/issues/${issue.id}` });

    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(issue);

    const timeline = await app.inject({ method: 'GET', url: `/issues/${issue.id}/events` });

    expect(timeline.statusCode).toBe(200);

    const body = timeline.json() as { events: IssueEventJson[] };

    expect(body.events).toHaveLength(1);

    const [event] = body.events;

    expect(event).toMatchObject({
      actorType: 'agent',
      actorId: 'api',
      entityType: 'issue',
      entityId: issue.id,
      type: 'issue.created',
      seq: issue.lastEventSeq,
    });
    expect(event?.payload.issue).toEqual({
      id: issue.id,
      key: issue.key,
      title: issue.title,
      body: issue.body,
      status: issue.status,
      priority: issue.priority,
      assignee: issue.assignee,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
    });
  });

  it('applies the SPEC defaults for optional fields', async () => {
    const issue = await createIssue({ title: 'Defaults' });

    expect(issue.body).toBe('');
    expect(issue.status).toBe('backlog');
    expect(issue.priority).toBe(0);
    expect(issue.assignee).toBeNull();
  });

  it('rejects invalid create bodies', async () => {
    const invalidBodies: Array<Record<string, unknown>> = [
      {},
      { title: '' },
      { title: 'Bad status', status: 'blocked' },
      { title: 'Bad priority', priority: 5 },
      { title: 'Negative priority', priority: -1 },
    ];

    for (const payload of invalidBodies) {
      const response = await app.inject({ method: 'POST', url: '/issues', payload });

      expect(response.statusCode).toBe(400);
      expect(response.headers['content-type']).toContain('application/json');
    }
  });

  it('ignores unknown fields instead of persisting them', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/issues',
      payload: { title: 'Extra fields', id: 'forged-id', lastEventSeq: 999 },
    });

    expect(response.statusCode).toBe(201);

    const issue = response.json() as IssueJson;

    expect(issue.id).not.toBe('forged-id');
    expect(issue.lastEventSeq).toBe(1);
  });
});

describe('GET /issues pagination', () => {
  it('walks newest-first in opaque cursor pages across at least three pages', async () => {
    for (let index = 1; index <= 7; index += 1) {
      await createIssue({ title: `Issue ${index}` });
    }

    const keys: number[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const query =
        cursor === null ? 'limit=2' : `limit=2&cursor=${encodeURIComponent(cursor)}`;
      const page = await listPage(query);

      expect(page.issues.length).toBeLessThanOrEqual(2);
      keys.push(...page.issues.map((issue) => issue.key));

      if (page.nextCursor !== null) {
        expect(typeof page.nextCursor).toBe('string');
        expect(page.nextCursor).not.toBe(String(page.issues.at(-1)?.key));
      }

      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(10);
    } while (cursor !== null);

    expect(pages).toBeGreaterThanOrEqual(3);
    expect(keys).toEqual([7, 6, 5, 4, 3, 2, 1]);
  });

  it('defaults to 50 issues per page', async () => {
    for (let index = 1; index <= 55; index += 1) {
      await createIssue({ title: `Issue ${index}` });
    }

    const page = await listPage('');

    expect(page.issues).toHaveLength(50);
    expect(page.issues[0]?.key).toBe(55);
    expect(page.issues.at(-1)?.key).toBe(6);
    expect(page.nextCursor).not.toBeNull();
  });

  it('accepts the maximum page size and rejects out-of-range or malformed paging', async () => {
    const max = await app.inject({ method: 'GET', url: '/issues?limit=100' });

    expect(max.statusCode).toBe(200);

    for (const query of [
      'limit=0',
      'limit=101',
      'limit=nope',
      'cursor=!!!',
      'cursor=Zm9v',
      'cursor=',
    ]) {
      const response = await app.inject({ method: 'GET', url: `/issues?${query}` });

      expect(response.statusCode).toBe(400);
      expect(response.headers['content-type']).toContain('application/json');
    }
  });
});

describe('GET /issues/:id/events', () => {
  it('returns only that issue timeline, oldest first', async () => {
    const first = await createIssue({ title: 'First' });
    const second = await createIssue({ title: 'Second' });

    const appendedSeq = await appendEvent(database.db, {
      actor: { type: 'agent', id: 'timeline-test' },
      entityType: 'issue',
      entityId: first.id,
      type: 'issue.updated',
      payload: { changed: ['title'] },
    });

    const firstTimeline = await app.inject({
      method: 'GET',
      url: `/issues/${first.id}/events`,
    });

    expect(firstTimeline.statusCode).toBe(200);

    const firstEvents = (firstTimeline.json() as { events: IssueEventJson[] }).events;

    expect(firstEvents.map((event) => event.seq)).toEqual([first.lastEventSeq, appendedSeq]);
    expect(firstEvents.map((event) => event.type)).toEqual(['issue.created', 'issue.updated']);

    const secondTimeline = await app.inject({
      method: 'GET',
      url: `/issues/${second.id}/events`,
    });

    expect(secondTimeline.statusCode).toBe(200);

    const secondEvents = (secondTimeline.json() as { events: IssueEventJson[] }).events;

    expect(secondEvents.map((event) => event.seq)).toEqual([second.lastEventSeq]);
    expect(secondEvents[0]?.entityId).toBe(second.id);
  });
});

describe('GET /issues/:id', () => {
  it('returns the full issue', async () => {
    const created = await createIssue({
      title: 'Full issue',
      body: 'Some body',
      status: 'in_progress',
      priority: 3,
      assignee: 'agent-2',
    });

    const response = await app.inject({ method: 'GET', url: `/issues/${created.id}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(created);
  });

  it('returns a JSON 404 for an unknown issue', async () => {
    const response = await app.inject({ method: 'GET', url: '/issues/does-not-exist' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'Issue not found',
    });
  });

  it('returns a JSON 404 for the timeline of an unknown issue', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/issues/does-not-exist/events',
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'Issue not found',
    });
  });
});

describe('rebuildProjections', () => {
  it('reproduces identical projection rows from the event log', async () => {
    await createIssue({ title: 'Backlog issue' });
    await createIssue({
      title: 'Urgent issue',
      body: 'Needs attention',
      status: 'todo',
      priority: 4,
      assignee: 'agent-1',
    });
    await createIssue({
      title: 'Done issue',
      status: 'done',
      priority: 1,
      assignee: null,
    });

    const before = (await listPage('limit=100')).issues;

    const result = await rebuildProjections(database.db);

    expect(result).toEqual({ events: 3, issues: 3 });

    const after = (await listPage('limit=100')).issues;

    expect(after).toEqual(before);
  });

  it('continues the key and event sequences after a rebuild', async () => {
    await createIssue({ title: 'First' });
    await createIssue({ title: 'Second' });

    await rebuildProjections(database.db);

    const next = await createIssue({ title: 'Third' });

    expect(next.key).toBe(3);
    expect(next.lastEventSeq).toBe(3);
  });

  it('leaves an empty database ready to start at key 1', async () => {
    const result = await rebuildProjections(database.db);

    expect(result).toEqual({ events: 0, issues: 0 });

    const issue = await createIssue({ title: 'After empty rebuild' });

    expect(issue.key).toBe(1);
    expect(issue.lastEventSeq).toBe(1);
  });
});
