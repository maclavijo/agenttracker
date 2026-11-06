import { JSDOM } from 'jsdom';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { databaseUrl } from '../src/config.js';
import { createDatabase } from '../src/db/client.js';
import {
  AGENT_ACTOR_ID,
  AGENT_TOKEN,
  HUMAN_ACTOR_ID,
  HUMAN_TOKEN,
  bearerAuthorization,
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
  at: string;
  actorType: string;
  actorId: string;
  entityType: string;
  entityId: string;
  type: string;
  payload: Record<string, unknown>;
  seq: number;
}

const database = createDatabase(databaseUrl());
const app = buildApp({
  db: database.db,
  ping: () => database.ping(),
  tokens: testTokens,
  webUiHumanToken: HUMAN_TOKEN,
});

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

async function createIssue(
  overrides: Partial<{ title: string; body: string; priority: number; assignee: string | null }> = {},
): Promise<IssueJson> {
  const response = await app.inject({
    method: 'POST',
    url: '/issues',
    headers: bearerAuthorization(AGENT_TOKEN),
    payload: {
      title: 'A UI issue',
      body: 'Body text',
      priority: 2,
      assignee: 'agent-7',
      ...overrides,
    },
  });

  expect(response.statusCode).toBe(201);
  return response.json() as IssueJson;
}

async function postAsHuman(issueId: string, body: string): Promise<unknown> {
  const response = await app.inject({
    method: 'POST',
    url: `/ui/issues/${issueId}/comments`,
    payload: { body },
  });

  expect(response.statusCode).toBe(201);
  return response.json();
}

async function getPage(): Promise<string> {
  const response = await app.inject({ method: 'GET', url: '/' });

  expect(response.statusCode).toBe(200);
  return response.body;
}

type StreamListener = (event: { data: string }) => void;

/** Minimal EventSource stand-in so the inline script runs under jsdom. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, StreamListener[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: StreamListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close(): void {
    this.readyState = 2;
  }

  emitOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  emitError(): void {
    this.readyState = 0;
    this.onerror?.();
  }

  emit(type: string, data: unknown): void {
    const event = { data: JSON.stringify(data) };

    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

interface LoadPageOptions {
  readonly failFetch?: boolean;
}

/** Loads the served HTML in jsdom, backing fetch with Fastify's inject(). */
function loadPage(html: string, path: string, options: LoadPageOptions = {}): JSDOM {
  FakeEventSource.instances = [];

  return new JSDOM(html, {
    url: 'http://127.0.0.1:3000' + path,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        if (options.failFetch) {
          return new Response(
            JSON.stringify({ statusCode: 503, error: 'Service Unavailable', message: 'down' }),
            { status: 503, headers: { 'content-type': 'application/json' } },
          );
        }

        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const requestPath = url.replace(/^https?:\/\/[^/]+\/?/, '/');
        const request: InjectOptions = {
          method: init?.method ?? 'GET',
          url: requestPath.startsWith('/') ? requestPath : '/' + requestPath,
        };

        if (typeof init?.body === 'string') {
          request.payload = init.body;
        }

        if (init?.headers !== undefined) {
          request.headers = init.headers as Record<string, string>;
        }

        const response = await app.inject(request);

        return new Response(response.body, {
          status: response.statusCode,
          headers: {
            'content-type': String(response.headers['content-type'] ?? 'application/json'),
          },
        });
      }) as typeof window.fetch;

      window.EventSource = FakeEventSource as unknown as typeof EventSource;
    },
  });
}

async function waitFor<T>(
  check: () => T | null | undefined | false,
  label: string,
  timeoutMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = check();

    if (value) {
      return value;
    }

    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('GET /', () => {
  it('serves the self-contained page with the expected elements', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['content-type']).toContain('charset=utf-8');
    expect(response.body.startsWith('<!doctype html>')).toBe(true);

    for (const marker of [
      'id="app"',
      'id="connection"',
      '<style>',
      '<script>',
      'new window.EventSource',
      'data-comments-enabled="true"',
    ]) {
      expect(response.body).toContain(marker);
    }

    expect(response.body).not.toContain(HUMAN_TOKEN);
  });

  it('marks commenting disabled when WEB_UI_HUMAN_TOKEN is not configured', async () => {
    const readOnly = buildApp({
      db: database.db,
      ping: () => database.ping(),
      tokens: testTokens,
    });

    await readOnly.ready();

    try {
      const response = await readOnly.inject({ method: 'GET', url: '/' });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('data-comments-enabled="false"');
      expect(response.body).not.toContain(HUMAN_TOKEN);
    } finally {
      await readOnly.close();
    }
  });
});

describe('POST /ui/issues/:id/comments', () => {
  it('attributes the comment to WEB_UI_HUMAN_TOKEN and never returns the token', async () => {
    const issue = await createIssue();
    const response = await app.inject({
      method: 'POST',
      url: `/ui/issues/${issue.id}/comments`,
      payload: { body: 'A human comment' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.body).not.toContain(HUMAN_TOKEN);
    expect(response.json()).toMatchObject({
      issueId: issue.id,
      body: 'A human comment',
      actorType: 'human',
      actorId: HUMAN_ACTOR_ID,
    });

    const comments = await app.inject({ method: 'GET', url: `/issues/${issue.id}/comments` });
    const body = comments.json() as { comments: EventJson[] };

    expect(comments.statusCode).toBe(200);
    expect(comments.body).not.toContain(HUMAN_TOKEN);
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0]).toMatchObject({
      actorType: 'human',
      actorId: HUMAN_ACTOR_ID,
      body: 'A human comment',
    });
  });

  it('exposes both an agent and a human event on the issue timeline', async () => {
    const issue = await createIssue();

    await postAsHuman(issue.id, 'A human comment');

    const response = await app.inject({ method: 'GET', url: `/issues/${issue.id}/events` });
    const events = (response.json() as { events: EventJson[] }).events;

    expect(response.statusCode).toBe(200);
    expect(events.map((event) => event.actorType)).toEqual(['agent', 'human']);
    expect(events.map((event) => event.actorId)).toEqual([AGENT_ACTOR_ID, HUMAN_ACTOR_ID]);
    expect(events.map((event) => event.type)).toEqual(['issue.created', 'comment.created']);
  });

  it('rejects an unknown issue and an empty body', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/ui/issues/does-not-exist/comments',
      payload: { body: 'Hello' },
    });

    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'Issue not found',
    });

    const issue = await createIssue();
    const invalid = await app.inject({
      method: 'POST',
      url: `/ui/issues/${issue.id}/comments`,
      payload: { body: '' },
    });

    expect(invalid.statusCode).toBe(400);
    expect(invalid.headers['content-type']).toContain('application/json');
  });

  it('answers 503 when commenting is not configured', async () => {
    const readOnly = buildApp({
      db: database.db,
      ping: () => database.ping(),
      tokens: testTokens,
    });

    await readOnly.ready();

    try {
      const issue = await createIssue();
      const response = await readOnly.inject({
        method: 'POST',
        url: `/ui/issues/${issue.id}/comments`,
        payload: { body: 'Hello' },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        statusCode: 503,
        error: 'Service Unavailable',
        message: 'Commenting is not configured on this server',
      });
    } finally {
      await readOnly.close();
    }
  });
});

describe('web UI token configuration', () => {
  it('fails fast on an unknown or agent token without echoing the secret', () => {
    const cases: Array<readonly [string, RegExp]> = [
      ['unknown-ui-token', /WEB_UI_HUMAN_TOKEN/],
      [AGENT_TOKEN, /human actor/],
    ];

    for (const [token, pattern] of cases) {
      try {
        buildApp({
          db: database.db,
          ping: () => database.ping(),
          tokens: testTokens,
          webUiHumanToken: token,
        });
        throw new Error('buildApp should have rejected the web UI token');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(pattern);
        expect((error as Error).message).not.toContain(token);
      }
    }
  });
});

describe('page rendering', () => {
  it('renders the issue list newest first with the required columns', async () => {
    const older = await createIssue({ title: 'Older issue' });
    const newer = await createIssue({ title: 'Newer issue' });
    const dom = loadPage(await getPage(), '/');

    try {
      const document = dom.window.document;
      await waitFor(
        () => document.querySelectorAll('#issue-list tbody tr').length === 2,
        'issue rows',
      );

      const headers = [...document.querySelectorAll('#issue-list thead th')].map(
        (node) => node.textContent,
      );

      expect(headers).toEqual(['#', 'Title', 'Status', 'Priority', 'Assignee', 'Updated']);

      const rows = [...document.querySelectorAll('#issue-list tbody tr')];

      expect(rows[0]?.textContent).toContain('Newer issue');
      expect(rows[1]?.textContent).toContain('Older issue');
      expect(rows[0]?.textContent).toContain(String(newer.key));
      expect(rows[1]?.textContent).toContain(String(older.key));
      expect(rows[0]?.querySelector('a')?.getAttribute('href')).toBe(`#/issues/${newer.id}`);
      expect(rows[0]?.textContent).toContain('backlog');
      expect(rows[0]?.textContent).toContain('agent-7');
    } finally {
      dom.window.close();
    }
  });

  it('shows the empty state when there are no issues', async () => {
    const dom = loadPage(await getPage(), '/');

    try {
      const document = dom.window.document;
      await waitFor(() => document.querySelector('.state-empty'), 'empty state');
      expect(document.getElementById('app')?.textContent).toContain('No issues yet.');
    } finally {
      dom.window.close();
    }
  });

  it('shows a retryable error state when the issue list cannot load', async () => {
    const dom = loadPage(await getPage(), '/', { failFetch: true });

    try {
      const document = dom.window.document;
      await waitFor(() => document.querySelector('.state-error'), 'error state');
      expect(document.getElementById('app')?.textContent).toContain('Could not load issues.');
      expect(document.querySelector('.state-retry')).not.toBeNull();
    } finally {
      dom.window.close();
    }
  });

  it('renders the issue detail and marks agent and human events', async () => {
    const issue = await createIssue({ title: 'Detail issue' });

    await postAsHuman(issue.id, 'Human note');

    const dom = loadPage(await getPage(), `/#/issues/${issue.id}`);

    try {
      const document = dom.window.document;
      await waitFor(
        () => document.querySelectorAll('#timeline .event').length === 2,
        'timeline rows',
      );

      const title = document.querySelector('.issue-title')?.textContent ?? '';

      expect(title).toContain('Detail issue');
      expect(title).toContain(`#${issue.key}`);
      expect(document.querySelector('.issue-body')?.textContent).toContain('Body text');
      expect(document.querySelector('.meta')?.textContent).toContain('Priority');

      const timeline = document.getElementById('timeline')?.textContent ?? '';

      expect(timeline).toContain('AGENT');
      expect(timeline).toContain(AGENT_ACTOR_ID);
      expect(timeline).toContain('HUMAN');
      expect(timeline).toContain(HUMAN_ACTOR_ID);
      expect(timeline).toContain('issue.created');
      expect(timeline).toContain('comment.created');
      expect(timeline).toContain('Human note');

      const badgeTypes = [...document.querySelectorAll('#timeline .actor-type')].map(
        (node) => node.textContent,
      );

      expect(badgeTypes).toEqual(['AGENT', 'HUMAN']);
    } finally {
      dom.window.close();
    }
  });

  it('appends a live event and shows live and reconnecting states without a reload', async () => {
    const issue = await createIssue({ title: 'Live issue' });
    const dom = loadPage(await getPage(), `/#/issues/${issue.id}`);

    try {
      const document = dom.window.document;
      await waitFor(
        () => document.querySelectorAll('#timeline .event').length === 1,
        'initial timeline',
      );

      const source = FakeEventSource.instances.at(-1);

      expect(source).toBeDefined();
      expect(source?.url).toBe(`/stream?since=${issue.lastEventSeq}`);

      source?.emitOpen();
      expect(document.getElementById('connection')?.textContent).toBe('live');
      expect(document.getElementById('connection')?.getAttribute('data-state')).toBe('live');

      const live = await app.inject({
        method: 'POST',
        url: `/issues/${issue.id}/comments`,
        headers: bearerAuthorization(AGENT_TOKEN),
        payload: { body: 'Live agent note' },
      });

      expect(live.statusCode).toBe(201);

      const timeline = await app.inject({ method: 'GET', url: `/issues/${issue.id}/events` });
      const event = (timeline.json() as { events: EventJson[] }).events.at(-1);

      expect(event).toBeDefined();
      source?.emit('comment.created', event);

      await waitFor(
        () => document.querySelectorAll('#timeline .event').length === 2,
        'live timeline row',
      );
      expect(document.getElementById('timeline')?.textContent).toContain('Live agent note');

      source?.emitError();
      expect(document.getElementById('connection')?.textContent).toBe('reconnecting…');
      expect(document.getElementById('connection')?.getAttribute('data-state')).toBe(
        'reconnecting',
      );
    } finally {
      dom.window.close();
    }
  });
});
