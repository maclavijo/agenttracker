import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { AuthConfigError, parseTokenDirectory } from '../src/auth.js';
import { databaseUrl } from '../src/config.js';
import { createDatabase } from '../src/db/client.js';
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
}

interface EventJson {
  actorType: string;
  actorId: string;
  type: string;
}

const database = createDatabase(databaseUrl());
const app = buildApp({ db: database.db, ping: () => database.ping(), tokens: testTokens });

function configError(env: NodeJS.ProcessEnv): AuthConfigError {
  try {
    parseTokenDirectory(env);
  } catch (error) {
    if (error instanceof AuthConfigError) {
      return error;
    }

    throw error;
  }

  throw new Error('expected parseTokenDirectory to throw');
}

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

async function createIssue(token: string, title: string): Promise<IssueJson> {
  const response = await app.inject({
    method: 'POST',
    url: '/issues',
    headers: bearerAuthorization(token),
    payload: { title },
  });

  expect(response.statusCode).toBe(201);

  return response.json() as IssueJson;
}

async function eventsFor(id: string): Promise<EventJson[]> {
  const response = await app.inject({ method: 'GET', url: `/issues/${id}/events` });

  expect(response.statusCode).toBe(200);

  return (response.json() as { events: EventJson[] }).events;
}

describe('token configuration', () => {
  it('parses comma-separated token:actorId entries for both actor types', () => {
    const directory = parseTokenDirectory({
      AGENT_TOKENS: 'agent-one:agent-1, agent-two:agent-2',
      HUMAN_TOKENS: 'human-one:person-1',
    });

    expect(directory.size).toBe(3);
    expect(directory.get('agent-one')).toEqual({ actorType: 'agent', actorId: 'agent-1' });
    expect(directory.get('agent-two')).toEqual({ actorType: 'agent', actorId: 'agent-2' });
    expect(directory.get('human-one')).toEqual({ actorType: 'human', actorId: 'person-1' });
  });

  it('treats unset and blank variables as no tokens', () => {
    expect(parseTokenDirectory({}).size).toBe(0);
    expect(parseTokenDirectory({ AGENT_TOKENS: '', HUMAN_TOKENS: '  , ' }).size).toBe(0);
  });

  it('rejects malformed entries without echoing the secret', () => {
    expect(() => parseTokenDirectory({ AGENT_TOKENS: 'no-colon' })).toThrow(AuthConfigError);
    expect(() => parseTokenDirectory({ HUMAN_TOKENS: ':person' })).toThrow(AuthConfigError);
    expect(() => parseTokenDirectory({ HUMAN_TOKENS: 'secret:' })).toThrow(AuthConfigError);

    const duplicate = configError({
      AGENT_TOKENS: 'leaky-secret:agent',
      HUMAN_TOKENS: 'leaky-secret:human',
    });

    expect(duplicate.message).not.toContain('leaky-secret');
  });

  it('rejects the same token configured for two actors', () => {
    expect(() =>
      parseTokenDirectory({ AGENT_TOKENS: 'same:agent', HUMAN_TOKENS: 'same:human' }),
    ).toThrow(AuthConfigError);
  });
});

describe('bearer token authentication', () => {
  const payload = { title: 'Authenticated issue' };

  it('rejects a write without an Authorization header with a JSON 401', async () => {
    const response = await app.inject({ method: 'POST', url: '/issues', payload });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'A valid bearer token is required',
    });
  });

  it('rejects an unknown token and a non-bearer authorization scheme', async () => {
    for (const authorization of ['Bearer not-a-real-token', 'Basic YWdlbnQ=', 'Bearer', '']) {
      const response = await app.inject({
        method: 'POST',
        url: '/issues',
        headers: { authorization },
        payload,
      });

      expect(response.statusCode).toBe(401);
      expect(response.headers['content-type']).toContain('application/json');
    }
  });

  it('protects PATCH and comment writes with the same hook', async () => {
    const issue = await createIssue(AGENT_TOKEN, 'Protected writes');

    const patch = await app.inject({
      method: 'PATCH',
      url: `/issues/${issue.id}`,
      payload: { title: 'Unauthenticated patch' },
    });

    expect(patch.statusCode).toBe(401);

    const comment = await app.inject({
      method: 'POST',
      url: `/issues/${issue.id}/comments`,
      payload: { body: 'Unauthenticated comment' },
    });

    expect(comment.statusCode).toBe(401);

    const events = await eventsFor(issue.id);

    expect(events).toHaveLength(1);
  });

  it('keeps read routes public', async () => {
    const issue = await createIssue(AGENT_TOKEN, 'Public reads');

    for (const url of ['/issues', `/issues/${issue.id}`, `/issues/${issue.id}/events`, `/issues/${issue.id}/comments`]) {
      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(200);
    }
  });

  it('attributes an event to the agent or human behind the token', async () => {
    const agentIssue = await createIssue(AGENT_TOKEN, 'Agent issue');
    const humanIssue = await createIssue(HUMAN_TOKEN, 'Human issue');

    const agentEvent = (await eventsFor(agentIssue.id))[0];
    const humanEvent = (await eventsFor(humanIssue.id))[0];

    expect(agentEvent).toMatchObject({
      type: 'issue.created',
      actorType: 'agent',
      actorId: AGENT_ACTOR_ID,
    });
    expect(humanEvent).toMatchObject({
      type: 'issue.created',
      actorType: 'human',
      actorId: HUMAN_ACTOR_ID,
    });
  });

  it('ignores an actor supplied in the request body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/issues',
      headers: bearerAuthorization(AGENT_TOKEN),
      payload: {
        title: 'Forged attribution',
        actor: { type: 'human', id: 'forged' },
        actorType: 'human',
        actorId: 'forged',
      },
    });

    expect(response.statusCode).toBe(201);

    const issue = response.json() as IssueJson;
    const [event] = await eventsFor(issue.id);

    expect(event).toMatchObject({ actorType: 'agent', actorId: AGENT_ACTOR_ID });
  });
});
