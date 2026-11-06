import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { databaseUrl } from '../src/config.js';
import { createDatabase } from '../src/db/client.js';
import { rebuildProjections } from '../src/issues/rebuild.js';
import {
  AGENT_ACTOR_ID,
  AGENT_TOKEN,
  bearerAuthorization,
  HUMAN_ACTOR_ID,
  HUMAN_TOKEN,
  testTokens,
  truncateAll,
} from './support.js';

interface IssueJson {
  id: string;
  title: string;
  status: string;
  priority: number;
  updatedAt: string;
  lastEventSeq: number;
}

interface CommentJson {
  id: number;
  issueId: string;
  body: string;
  actorType: string;
  actorId: string;
  createdAt: string;
}

interface EventJson {
  id: number;
  actorType: string;
  actorId: string;
  type: string;
  payload: Record<string, unknown>;
  seq: number;
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

async function createIssue(title = 'Commented issue'): Promise<IssueJson> {
  const response = await app.inject({
    method: 'POST',
    url: '/issues',
    headers: bearerAuthorization(AGENT_TOKEN),
    payload: { title },
  });

  expect(response.statusCode).toBe(201);

  return response.json() as IssueJson;
}

async function addComment(
  issueId: string,
  body: string,
  token: string = HUMAN_TOKEN,
) {
  return app.inject({
    method: 'POST',
    url: `/issues/${issueId}/comments`,
    headers: bearerAuthorization(token),
    payload: { body },
  });
}

async function getComments(issueId: string): Promise<CommentJson[]> {
  const response = await app.inject({ method: 'GET', url: `/issues/${issueId}/comments` });

  expect(response.statusCode).toBe(200);

  return (response.json() as { comments: CommentJson[] }).comments;
}

async function eventsFor(id: string): Promise<EventJson[]> {
  const response = await app.inject({ method: 'GET', url: `/issues/${id}/events` });

  expect(response.statusCode).toBe(200);

  return (response.json() as { events: EventJson[] }).events;
}

describe('POST /issues/:id/comments', () => {
  it('appends comment.created and returns the comment with its id and actor', async () => {
    const issue = await createIssue();

    const response = await addComment(issue.id, 'I reviewed this change.');

    expect(response.statusCode).toBe(201);
    expect(response.headers['content-type']).toContain('application/json');

    const comment = response.json() as CommentJson;

    expect(comment).toMatchObject({
      issueId: issue.id,
      body: 'I reviewed this change.',
      actorType: 'human',
      actorId: HUMAN_ACTOR_ID,
    });
    expect(Number.isInteger(comment.id)).toBe(true);
    expect(Number.isNaN(Date.parse(comment.createdAt))).toBe(false);

    expect(await getComments(issue.id)).toEqual([comment]);

    const events = await eventsFor(issue.id);

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      id: comment.id,
      type: 'comment.created',
      actorType: 'human',
      actorId: HUMAN_ACTOR_ID,
    });
    expect(events[1]?.payload).toEqual({ body: 'I reviewed this change.' });
  });

  it('returns comments oldest first with their different authors', async () => {
    const issue = await createIssue();

    const first = await addComment(issue.id, 'From the agent', AGENT_TOKEN);
    const second = await addComment(issue.id, 'From the human', HUMAN_TOKEN);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);

    const comments = await getComments(issue.id);

    expect(comments.map((comment) => comment.body)).toEqual([
      'From the agent',
      'From the human',
    ]);
    expect(comments.map((comment) => comment.actorType)).toEqual(['agent', 'human']);
    expect(comments.map((comment) => comment.actorId)).toEqual([
      AGENT_ACTOR_ID,
      HUMAN_ACTOR_ID,
    ]);
    expect(comments.map((comment) => comment.id)).toEqual([
      (first.json() as CommentJson).id,
      (second.json() as CommentJson).id,
    ]);
  });

  it('does not change the issue projection', async () => {
    const issue = await createIssue();

    await addComment(issue.id, 'A note');

    const after = await app.inject({ method: 'GET', url: `/issues/${issue.id}` });

    expect(after.statusCode).toBe(200);
    expect(after.json()).toMatchObject({
      title: issue.title,
      updatedAt: issue.updatedAt,
      lastEventSeq: issue.lastEventSeq,
    });
  });

  it('rejects invalid comment bodies', async () => {
    const issue = await createIssue();

    for (const payload of [{}, { body: '' }, { body: null }]) {
      const response = await app.inject({
        method: 'POST',
        url: `/issues/${issue.id}/comments`,
        headers: bearerAuthorization(AGENT_TOKEN),
        payload,
      });

      expect(response.statusCode).toBe(400);
      expect(response.headers['content-type']).toContain('application/json');
    }

    expect(await getComments(issue.id)).toEqual([]);
  });

  it('ignores a body-supplied actor', async () => {
    const issue = await createIssue();

    const response = await app.inject({
      method: 'POST',
      url: `/issues/${issue.id}/comments`,
      headers: bearerAuthorization(HUMAN_TOKEN),
      payload: {
        body: 'Attributed by token',
        actor: { type: 'agent', id: 'forged' },
        actorType: 'agent',
        actorId: 'forged',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      actorType: 'human',
      actorId: HUMAN_ACTOR_ID,
    });
  });

  it('returns a JSON 404 for an unknown issue', async () => {
    const post = await addComment('does-not-exist', 'Lost comment');
    const get = await app.inject({ method: 'GET', url: '/issues/does-not-exist/comments' });

    expect(post.statusCode).toBe(404);
    expect(get.statusCode).toBe(404);
    expect(get.json()).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'Issue not found',
    });
  });
});

describe('comments and updates through rebuildProjections', () => {
  it('survives db:rebuild-projections with identical issues, comments and timeline', async () => {
    const issue = await createIssue('Rebuild survivor');

    const patch = await app.inject({
      method: 'PATCH',
      url: `/issues/${issue.id}`,
      headers: bearerAuthorization(AGENT_TOKEN),
      payload: { title: 'Rebuilt title', priority: 3, status: 'in_progress' },
    });

    expect(patch.statusCode).toBe(200);

    await addComment(issue.id, 'First comment', AGENT_TOKEN);
    await addComment(issue.id, 'Second comment', HUMAN_TOKEN);

    const issueBefore = await app.inject({ method: 'GET', url: `/issues/${issue.id}` });
    const eventsBefore = await eventsFor(issue.id);
    const commentsBefore = await getComments(issue.id);

    const result = await rebuildProjections(database.db);

    expect(result).toEqual({ events: 4, issues: 1 });

    const issueAfter = await app.inject({ method: 'GET', url: `/issues/${issue.id}` });

    expect(issueAfter.statusCode).toBe(200);
    expect(issueAfter.json()).toEqual(issueBefore.json());
    expect(await eventsFor(issue.id)).toEqual(eventsBefore);
    expect(await getComments(issue.id)).toEqual(commentsBefore);
    expect(commentsBefore).toHaveLength(2);
  });
});
