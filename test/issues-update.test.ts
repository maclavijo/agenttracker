import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { databaseUrl } from '../src/config.js';
import { createDatabase } from '../src/db/client.js';
import {
  AGENT_TOKEN,
  bearerAuthorization,
  HUMAN_ACTOR_ID,
  HUMAN_TOKEN,
  testTokens,
  truncateAll,
} from './support.js';

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

interface EventJson {
  id: number;
  actorType: string;
  actorId: string;
  entityType: string;
  entityId: string;
  type: string;
  payload: Record<string, unknown>;
  seq: number;
}

interface CreateBody {
  title: string;
  body?: string;
  status?: string;
  priority?: number;
  assignee?: string | null;
}

const database = createDatabase(databaseUrl());
const app = buildApp({ db: database.db, ping: () => database.ping(), tokens: testTokens });

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
    headers: bearerAuthorization(AGENT_TOKEN),
    payload: { title: 'A test issue', ...overrides },
  });

  expect(response.statusCode).toBe(201);

  return response.json() as IssueJson;
}

async function patchIssue(
  id: string,
  payload: Record<string, unknown>,
  token: string = HUMAN_TOKEN,
) {
  return app.inject({
    method: 'PATCH',
    url: `/issues/${id}`,
    headers: bearerAuthorization(token),
    payload,
  });
}

async function eventsFor(id: string): Promise<EventJson[]> {
  const response = await app.inject({ method: 'GET', url: `/issues/${id}/events` });

  expect(response.statusCode).toBe(200);

  return (response.json() as { events: EventJson[] }).events;
}

async function getIssue(id: string): Promise<IssueJson> {
  const response = await app.inject({ method: 'GET', url: `/issues/${id}` });

  expect(response.statusCode).toBe(200);

  return response.json() as IssueJson;
}

describe('PATCH /issues/:id', () => {
  it('changes only the given fields and appends exactly one event with only those fields', async () => {
    const created = await createIssue({
      title: 'Original title',
      body: 'Original body',
      status: 'todo',
      priority: 2,
      assignee: 'agent-7',
    });

    const response = await patchIssue(created.id, { title: 'Renamed title' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');

    const updated = response.json() as IssueJson;

    expect(updated).toMatchObject({
      id: created.id,
      key: created.key,
      title: 'Renamed title',
      body: 'Original body',
      status: 'todo',
      priority: 2,
      assignee: 'agent-7',
    });
    expect(updated.lastEventSeq).toBeGreaterThan(created.lastEventSeq);

    const events = await eventsFor(created.id);

    expect(events).toHaveLength(2);

    const updateEvent = events[1];

    expect(updateEvent).toMatchObject({
      type: 'issue.updated',
      actorType: 'human',
      actorId: HUMAN_ACTOR_ID,
      entityType: 'issue',
      entityId: created.id,
      seq: updated.lastEventSeq,
    });
    expect(updateEvent?.payload).toEqual({ title: 'Renamed title' });
    expect(await getIssue(created.id)).toEqual(updated);
  });

  it('applies a multi-field update and can clear the assignee', async () => {
    const created = await createIssue({
      title: 'Multi-field',
      body: 'Body text',
      status: 'todo',
      priority: 1,
      assignee: 'agent-9',
    });

    const response = await patchIssue(created.id, {
      status: 'done',
      priority: 4,
      assignee: null,
      body: '',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      title: 'Multi-field',
      body: '',
      status: 'done',
      priority: 4,
      assignee: null,
    });

    const events = await eventsFor(created.id);
    const updateEvent = events[1];

    expect(events).toHaveLength(2);
    expect(updateEvent?.payload).toEqual({
      body: '',
      status: 'done',
      priority: 4,
      assignee: null,
    });
  });

  it('rejects an invalid status or priority without appending an event', async () => {
    const created = await createIssue({ status: 'todo', priority: 2 });

    for (const payload of [
      { status: 'blocked' },
      { status: 3 },
      { priority: 5 },
      { priority: -1 },
      { priority: 1.5 },
      { priority: 'high' },
    ]) {
      const response = await patchIssue(created.id, payload);

      expect(response.statusCode).toBe(400);
      expect(response.headers['content-type']).toContain('application/json');
    }

    const events = await eventsFor(created.id);

    expect(events).toHaveLength(1);
    expect(await getIssue(created.id)).toEqual(created);
  });

  it('rejects an empty patch or one with no recognized fields', async () => {
    const created = await createIssue();

    for (const payload of [{}, { actor: { type: 'agent', id: 'forged' } }]) {
      const response = await patchIssue(created.id, payload);

      expect(response.statusCode).toBe(400);
      expect(response.headers['content-type']).toContain('application/json');
    }

    expect(await eventsFor(created.id)).toHaveLength(1);
  });

  it('returns a JSON 404 for an unknown issue', async () => {
    const response = await patchIssue('does-not-exist', { title: 'Nope' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'Issue not found',
    });
  });

  it('ignores a body-supplied actor and records the token actor', async () => {
    const created = await createIssue();

    const response = await patchIssue(created.id, {
      title: 'Token actor wins',
      actor: { type: 'agent', id: 'forged' },
      actorType: 'agent',
      actorId: 'forged',
    });

    expect(response.statusCode).toBe(200);

    const events = await eventsFor(created.id);
    const updateEvent = events[1];

    expect(updateEvent).toMatchObject({ actorType: 'human', actorId: HUMAN_ACTOR_ID });
    expect(updateEvent?.payload).toEqual({ title: 'Token actor wins' });
  });
});
