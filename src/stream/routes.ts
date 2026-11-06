import { and, asc, desc, gt, lte } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerResponse } from 'node:http';
import type { Database } from '../db/client.js';
import { events } from '../db/schema.js';
import { toEventJson } from '../events.js';
import type { EventJson } from '../events.js';
import type { EventStreamHub } from './hub.js';

/** `retry:` hint sent once at the start of every stream, in milliseconds. */
export const STREAM_RETRY_MS = 3_000;

/** Heartbeat comment cadence; keeps proxies from timing out an idle stream. */
export const STREAM_HEARTBEAT_MS = 15_000;

/** A client whose unsent buffer grows past this is disconnected, not queued. */
export const STREAM_MAX_PENDING_BYTES = 8_000_000;

/**
 * Caps on events buffered while the initial replay runs. Hitting one closes the
 * stream so the client reconnects from its last `id` instead of growing memory.
 */
export const STREAM_MAX_BUFFERED_EVENTS = 1_000;
export const STREAM_MAX_BUFFERED_CHARS = 8_000_000;

const REPLAY_BATCH_SIZE = 100;

export interface StreamRouteOptions {
  readonly heartbeatMs?: number;
  readonly maxPendingBytes?: number;
}

interface StreamQuery {
  since?: number;
}

const streamQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    since: { type: 'integer', minimum: 0 },
  },
};

/**
 * Registers `GET /stream`.
 *
 * The route replays committed events after `since` (or `Last-Event-ID`, which
 * `since` overrides) and then keeps the response open, writing each newly
 * appended event as it is committed. Without either input the stream starts at
 * the current head of the log: only events appended after the connection open
 * are delivered.
 */
export function registerStreamRoutes(
  app: FastifyInstance,
  db: Database,
  hub: EventStreamHub,
  options: StreamRouteOptions = {},
): void {
  const heartbeatMs = options.heartbeatMs ?? STREAM_HEARTBEAT_MS;
  const maxPendingBytes = options.maxPendingBytes ?? STREAM_MAX_PENDING_BYTES;
  const sessions = new Set<StreamSession>();

  app.addHook('onClose', async () => {
    for (const session of [...sessions]) {
      session.stop();
    }

    sessions.clear();
  });

  app.get<{ Querystring: StreamQuery }>(
    '/stream',
    { schema: { querystring: streamQuerySchema } },
    (request, reply) => {
      let after: number | null;

      try {
        after = resolveAfter(request);
      } catch (error) {
        if (error instanceof InvalidSinceError) {
          return reply.code(400).send({
            statusCode: 400,
            error: 'Bad Request',
            message: error.message,
          });
        }

        throw error;
      }

      const session: StreamSession = new StreamSession({
        db,
        hub,
        reply,
        after,
        heartbeatMs,
        maxPendingBytes,
        onClose: () => {
          sessions.delete(session);
        },
      });

      sessions.add(session);
      reply.hijack();
      session.start();
    },
  );
}

class InvalidSinceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSinceError';
  }
}

/** `since` wins; otherwise a valid `Last-Event-ID`; otherwise the current head. */
function resolveAfter(request: FastifyRequest<{ Querystring: StreamQuery }>): number | null {
  if (request.query.since !== undefined) {
    return request.query.since;
  }

  const header = request.headers['last-event-id'];

  if (header === undefined) {
    return null;
  }

  const raw = Array.isArray(header) ? header[0] : header;

  if (raw === undefined) {
    return null;
  }

  const value = raw.trim();

  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new InvalidSinceError('Last-Event-ID must be a non-negative integer');
  }

  const seq = Number(value);

  if (!Number.isSafeInteger(seq)) {
    throw new InvalidSinceError('Last-Event-ID is out of range');
  }

  return seq;
}

interface StreamSessionOptions {
  readonly db: Database;
  readonly hub: EventStreamHub;
  readonly reply: FastifyReply;
  readonly after: number | null;
  readonly heartbeatMs: number;
  readonly maxPendingBytes: number;
  readonly onClose: () => void;
}

type Phase = 'replaying' | 'live' | 'closed';

/**
 * One SSE response: its replay, live phase, heartbeat and cleanup.
 *
 * While the replay runs, live events are buffered and written afterwards only
 * when their `seq` is past the replay cursor, so the client sees the log in
 * order without duplicates across the replay/live boundary.
 */
class StreamSession {
  private readonly db: Database;
  private readonly hub: EventStreamHub;
  private readonly raw: ServerResponse;
  private readonly after: number | null;
  private readonly heartbeatMs: number;
  private readonly maxPendingBytes: number;
  private readonly onClose: () => void;
  private readonly buffered: Array<{ readonly seq: number; readonly frame: string }> = [];
  private bufferedChars = 0;
  private phase: Phase = 'replaying';
  private cursor = 0;
  private unsubscribe: (() => void) | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(options: StreamSessionOptions) {
    this.db = options.db;
    this.hub = options.hub;
    this.raw = options.reply.raw;
    this.after = options.after;
    this.heartbeatMs = options.heartbeatMs;
    this.maxPendingBytes = options.maxPendingBytes;
    this.onClose = options.onClose;
  }

  start(): void {
    this.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    this.raw.on('close', () => {
      this.stop();
    });

    this.raw.on('error', () => {
      this.stop();
    });

    this.writeFrame(`retry: ${STREAM_RETRY_MS}\n\n`);

    this.unsubscribe = this.hub.subscribe((event) => {
      this.onEvent(event);
    });

    this.heartbeatTimer = setInterval(() => {
      this.writeFrame(': heartbeat\n\n');
    }, this.heartbeatMs);
    this.heartbeatTimer.unref();

    void this.replay();
  }

  private get isClosed(): boolean {
    return this.phase === 'closed';
  }

  stop(): void {
    if (this.isClosed) {
      return;
    }

    this.phase = 'closed';
    this.buffered.length = 0;
    this.bufferedChars = 0;

    if (this.unsubscribe !== null) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.onClose();

    if (!this.raw.writableEnded) {
      this.raw.end();
    }
  }

  private onEvent(event: EventJson): void {
    if (this.isClosed) {
      return;
    }

    if (this.phase === 'replaying') {
      const frame = encodeEvent(event);

      if (
        this.buffered.length >= STREAM_MAX_BUFFERED_EVENTS ||
        this.bufferedChars + frame.length > STREAM_MAX_BUFFERED_CHARS
      ) {
        console.warn('SSE replay could not keep up with appended events; closing the stream');
        this.abort();
        return;
      }

      this.buffered.push({ seq: event.seq, frame });
      this.bufferedChars += frame.length;
      return;
    }

    this.writeEvent(event);
  }

  private async replay(): Promise<void> {
    try {
      // Snapshot the head first: the replay covers (after, head], and anything
      // appended later reaches the buffered/live path.
      const head = await headSeq(this.db);
      this.cursor = this.after ?? head;

      for (;;) {
        if (this.isClosed) {
          return;
        }

        const rows = await this.db
          .select()
          .from(events)
          .where(and(gt(events.seq, this.cursor), lte(events.seq, head)))
          .orderBy(asc(events.seq))
          .limit(REPLAY_BATCH_SIZE);

        if (rows.length === 0) {
          break;
        }

        for (const row of rows) {
          if (this.isClosed) {
            return;
          }

          this.writeEvent(toEventJson(row));
        }

        await yieldToEventLoop();
      }

      this.flushBuffered();
      this.phase = 'live';
    } catch (error) {
      console.error('SSE replay failed:', error);
      this.abort();
    }
  }

  private flushBuffered(): void {
    const pending = this.buffered.splice(0).sort((left, right) => left.seq - right.seq);
    this.bufferedChars = 0;

    for (const event of pending) {
      if (this.isClosed) {
        return;
      }

      if (event.seq > this.cursor) {
        this.cursor = event.seq;
        this.writeFrame(event.frame);
      }
    }
  }

  private writeEvent(event: EventJson): void {
    this.cursor = Math.max(this.cursor, event.seq);
    this.writeFrame(encodeEvent(event));
  }

  private writeFrame(frame: string): void {
    if (this.isClosed) {
      return;
    }

    const flushed = this.raw.write(frame);

    if (!flushed && this.raw.writableLength > this.maxPendingBytes) {
      console.warn('SSE client is not reading; closing the stream instead of buffering');
      this.abort();
    }
  }

  /** Closes the stream by destroying the socket, dropping unsent buffered data. */
  private abort(): void {
    if (this.isClosed) {
      return;
    }

    this.stop();

    if (!this.raw.destroyed) {
      this.raw.destroy();
    }
  }
}

async function headSeq(db: Database): Promise<number> {
  const [row] = await db
    .select({ seq: events.seq })
    .from(events)
    .orderBy(desc(events.seq))
    .limit(1);

  return row?.seq ?? 0;
}

function encodeEvent(event: EventJson): string {
  // Framing is line based, so a newline in the event type would corrupt it.
  const type = event.type.replace(/[\r\n]/g, '');

  return `id: ${event.seq}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
