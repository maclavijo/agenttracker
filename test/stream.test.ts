import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { databaseUrl } from '../src/config.js';
import { createDatabase } from '../src/db/client.js';
import { appendEvent } from '../src/events.js';
import { EventStreamHub } from '../src/stream/hub.js';
import {
  AGENT_ACTOR_ID,
  AGENT_TOKEN,
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
  payload: { issue?: { id: string }; [key: string]: unknown };
  seq: number;
}

interface SseFrame {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
  retry?: string;
}

const database = createDatabase(databaseUrl());
const hub = new EventStreamHub(database.db, {
  connectionString: databaseUrl(),
  reconnectDelayMs: 200,
});
const app = buildApp(
  {
    db: database.db,
    ping: () => database.ping(),
    tokens: testTokens,
    stream: hub,
    streamOptions: { heartbeatMs: 50 },
  },
  { forceCloseConnections: true },
);

let baseUrl: string;
const clients = new Set<SseClient>();

beforeAll(async () => {
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
});

beforeEach(async () => {
  await truncateAll(database.db);
});

afterEach(() => {
  for (const client of clients) {
    client.close();
  }

  clients.clear();
});

afterAll(async () => {
  await truncateAll(database.db);
  await app.close();
  await database.close();
});

function track(client: SseClient): SseClient {
  clients.add(client);
  return client;
}

async function connect(path: string, headers: Record<string, string> = {}): Promise<SseClient> {
  return track(await SseClient.connect(`${baseUrl}${path}`, headers));
}

async function createIssue(overrides: Record<string, unknown> = {}): Promise<IssueJson> {
  const response = await fetch(`${baseUrl}/issues`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearerAuthorization(AGENT_TOKEN) },
    body: JSON.stringify({ title: 'A streamed issue', ...overrides }),
  });

  expect(response.status).toBe(201);

  return (await response.json()) as IssueJson;
}

function parseData(frame: SseFrame): EventJson {
  if (frame.data === undefined) {
    throw new Error(`SSE frame has no data: ${JSON.stringify(frame)}`);
  }

  return JSON.parse(frame.data) as EventJson;
}

function eventSeq(frame: SseFrame): number {
  return Number(frame.id);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('condition was not met before the timeout');
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1));

  return sorted[index] as number;
}

/** A real HTTP SSE consumer: parses frames and lets a test await them. */
class SseClient {
  private readonly controller = new AbortController();
  private readonly frames: SseFrame[] = [];
  private readonly waiters: Array<{
    resolve: (frame: SseFrame) => void;
    reject: (error: Error) => void;
  }> = [];
  private buffer = '';
  private ended = false;

  private constructor() {}

  static async connect(url: string, headers: Record<string, string>): Promise<SseClient> {
    const client = new SseClient();
    const response = await fetch(url, {
      headers: { accept: 'text/event-stream', ...headers },
      signal: client.controller.signal,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    void client.pump(response);
    return client;
  }

  async next(timeoutMs = 2_000): Promise<SseFrame> {
    const frame = this.frames.shift();

    if (frame !== undefined) {
      return frame;
    }

    if (this.ended) {
      throw new Error('the SSE connection ended before a frame arrived');
    }

    return new Promise<SseFrame>((resolve, reject) => {
      const waiter = {
        resolve: (value: SseFrame): void => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error: Error): void => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);

        if (index !== -1) {
          this.waiters.splice(index, 1);
        }

        reject(new Error('timed out waiting for an SSE frame'));
      }, timeoutMs);

      this.waiters.push(waiter);
    });
  }

  async nextEvent(type: string, timeoutMs = 2_000): Promise<SseFrame> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const frame = await this.next(Math.max(1, deadline - Date.now()));

      if (frame.event === type) {
        return frame;
      }

      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for SSE event "${type}"`);
      }
    }
  }

  close(): void {
    this.controller.abort();
  }

  private async pump(response: Response): Promise<void> {
    const body = response.body;

    if (body === null) {
      this.ended = true;
      this.wake();
      return;
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();

    try {
      for (;;) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        this.consume(decoder.decode(value, { stream: true }));
      }
    } catch {
      // close() aborts the response, and a terminated stream rejects the read.
    } finally {
      this.ended = true;
      this.wake();
    }
  }

  private consume(text: string): void {
    this.buffer += text.replace(/\r\n/g, '\n');

    for (;;) {
      const boundary = this.buffer.indexOf('\n\n');

      if (boundary === -1) {
        return;
      }

      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);

      const frame = parseFrame(block);

      if (frame !== null) {
        this.frames.push(frame);
        this.wake();
      }
    }
  }

  private wake(): void {
    while (this.waiters.length > 0 && this.frames.length > 0) {
      this.waiters.shift()?.resolve(this.frames.shift() as SseFrame);
    }

    if (this.ended) {
      for (const waiter of this.waiters.splice(0)) {
        waiter.reject(new Error('the SSE connection ended'));
      }
    }
  }
}

function parseFrame(block: string): SseFrame | null {
  const frame: SseFrame = {};
  let hasField = false;

  for (const line of block.split('\n')) {
    if (line === '') {
      continue;
    }

    if (line.startsWith(':')) {
      frame.comment = line.slice(1).trim();
      hasField = true;
      continue;
    }

    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '');

    hasField = true;

    switch (field) {
      case 'id':
        frame.id = value;
        break;
      case 'event':
        frame.event = value;
        break;
      case 'data':
        frame.data = frame.data === undefined ? value : `${frame.data}\n${value}`;
        break;
      case 'retry':
        frame.retry = value;
        break;
      default:
        break;
    }
  }

  return hasField ? frame : null;
}

describe('GET /stream', () => {
  it('opens with a retry hint and sends heartbeat comments while idle', async () => {
    const client = await connect('/stream');

    const retry = await client.next();
    expect(retry.retry).toBe('3000');

    const heartbeat = await client.next(2_000);
    expect(heartbeat.comment).toBe('heartbeat');
    expect(heartbeat.event).toBeUndefined();
    expect(heartbeat.id).toBeUndefined();
  });

  it('replays every event after since, then pushes appended events live', async () => {
    const first = await createIssue({ title: 'First' });
    await createIssue({ title: 'Second' });
    await createIssue({ title: 'Third' });

    const client = await connect(`/stream?since=${first.lastEventSeq}`);

    const replayedSecond = await client.nextEvent('issue.created');
    const replayedThird = await client.nextEvent('issue.created');

    expect(eventSeq(replayedSecond)).toBe(2);
    expect(parseData(replayedSecond).seq).toBe(2);
    expect(eventSeq(replayedThird)).toBe(3);

    const live = await createIssue({ title: 'Live' });
    const liveFrame = await client.nextEvent('issue.created');

    expect(eventSeq(liveFrame)).toBe(4);
    expect(parseData(liveFrame).entityId).toBe(live.id);
    expect(parseData(liveFrame).payload.issue?.id).toBe(live.id);
  });

  it('delivers events appended through another database connection', async () => {
    // The MCP server writes from its own process and connection; the stream
    // must still see those appends.
    const other = createDatabase(databaseUrl());

    try {
      const client = await connect('/stream');
      const appended = await appendEvent(other.db, {
        actor: { type: 'agent', id: 'other-process' },
        entityType: 'issue',
        entityId: 'other-process-entity',
        type: 'issue.updated',
        payload: { source: 'other-process' },
      });

      const frame = await client.nextEvent('issue.updated');

      expect(eventSeq(frame)).toBe(appended.seq);
      expect(parseData(frame).actorId).toBe('other-process');
    } finally {
      await other.close();
    }
  });

  it('does not stream an append whose transaction rolls back', async () => {
    const client = await connect('/stream');

    await expect(
      database.db.transaction(async (tx) => {
        await appendEvent(tx, {
          actor: { type: 'agent', id: 'rollback-test' },
          entityType: 'issue',
          entityId: 'rolled-back',
          type: 'issue.updated',
          payload: { rolledBack: true },
        });

        throw new Error('roll back on purpose');
      }),
    ).rejects.toThrow('roll back on purpose');

    await expect(client.nextEvent('issue.updated', 250)).rejects.toThrow('timed out');

    const issue = await createIssue({ title: 'After rollback' });
    const frame = await client.nextEvent('issue.created');

    expect(parseData(frame).entityId).toBe(issue.id);
  });

  it('starts at the current head when since and Last-Event-ID are absent', async () => {
    await createIssue({ title: 'Before connect' });
    await createIssue({ title: 'Also before connect' });

    const client = await connect('/stream');

    const live = await createIssue({ title: 'After connect' });
    const frame = await client.nextEvent('issue.created');

    expect(eventSeq(frame)).toBe(3);
    expect(parseData(frame).entityId).toBe(live.id);
  });

  it('honours Last-Event-ID when no since is given', async () => {
    await createIssue({ title: 'One' });
    await createIssue({ title: 'Two' });
    await createIssue({ title: 'Three' });

    const client = await connect('/stream', { 'last-event-id': '1' });

    expect(eventSeq(await client.nextEvent('issue.created'))).toBe(2);
    expect(eventSeq(await client.nextEvent('issue.created'))).toBe(3);
  });

  it('prefers the since query over Last-Event-ID', async () => {
    await createIssue({ title: 'One' });
    await createIssue({ title: 'Two' });
    await createIssue({ title: 'Three' });

    const client = await connect('/stream?since=2', { 'last-event-id': '1' });
    const frame = await client.nextEvent('issue.created');

    expect(eventSeq(frame)).toBe(3);
  });

  it('frames each event with id, event and the full JSON event', async () => {
    const issue = await createIssue({ title: 'Framing', priority: 2 });

    const client = await connect('/stream?since=0');
    const frame = await client.nextEvent('issue.created');
    const event = parseData(frame);

    expect(frame.id).toBe('1');
    expect(frame.event).toBe('issue.created');
    expect(event).toMatchObject({
      actorType: 'agent',
      actorId: AGENT_ACTOR_ID,
      entityType: 'issue',
      entityId: issue.id,
      type: 'issue.created',
      seq: 1,
    });
    expect(typeof event.id).toBe('number');
    expect(event.payload.issue).toMatchObject({ id: issue.id, title: 'Framing', priority: 2 });
    expect(Number.isNaN(Date.parse(event.at))).toBe(false);
  });

  it('replays across multiple batches in seq order', async () => {
    for (let index = 1; index <= 105; index += 1) {
      await appendEvent(database.db, {
        actor: { type: 'agent', id: 'batch-test' },
        entityType: 'issue',
        entityId: 'batch-entity',
        type: 'issue.updated',
        payload: { index },
      });
    }

    const client = await connect('/stream?since=0');

    for (let seq = 1; seq <= 105; seq += 1) {
      const frame = await client.nextEvent('issue.updated');

      expect(eventSeq(frame)).toBe(seq);
    }
  });

  it('keeps append-to-delivery p95 latency under the 150 ms target', async () => {
    const client = await connect('/stream');
    const latencies: number[] = [];

    for (let index = 0; index < 20; index += 1) {
      const startedAt = performance.now();
      const issue = await createIssue({ title: `Latency ${index}` });
      const frame = await client.nextEvent('issue.created');
      latencies.push(performance.now() - startedAt);

      expect(eventSeq(frame)).toBe(issue.lastEventSeq);
    }

    expect(percentile(latencies, 0.95)).toBeLessThan(150);
  });

  it('removes the subscription when a client disconnects', async () => {
    const client = await connect('/stream');

    await waitFor(() => hub.subscriberCount === 1);

    client.close();

    await waitFor(() => hub.subscriberCount === 0);
    clients.delete(client);
  });

  it('rejects an invalid since or Last-Event-ID', async () => {
    for (const url of ['/stream?since=-1', '/stream?since=abc', '/stream?since=1.5']) {
      const response = await fetch(`${baseUrl}${url}`);

      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/json');
      await response.body?.cancel();
    }

    const response = await fetch(`${baseUrl}/stream`, { headers: { 'last-event-id': 'nope' } });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Last-Event-ID must be a non-negative integer',
    });
  });

  it('resumes delivery after the listener connection is dropped', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = await connect('/stream');

    try {
      await database.db.execute(sql`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE application_name = 'agenttracker_stream'
      `);

      await waitFor(() => !hub.listening);
      await waitFor(() => hub.listening);

      const issue = await createIssue({ title: 'After reconnect' });
      const frame = await client.nextEvent('issue.created');

      expect(parseData(frame).entityId).toBe(issue.id);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
