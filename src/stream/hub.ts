import { eq } from 'drizzle-orm';
import { Client } from 'pg';
import type { Database } from '../db/client.js';
import { events } from '../db/schema.js';
import { EVENT_STREAM_CHANNEL, toEventJson } from '../events.js';
import type { EventJson } from '../events.js';

/** Receives every committed event in `seq` order as the database reports it. */
export type StreamSubscriber = (event: EventJson) => void;

export interface EventStreamHubOptions {
  readonly connectionString: string;
  /** Delay before a failed listener connection is reopened. */
  readonly reconnectDelayMs?: number;
}

export const DEFAULT_RECONNECT_DELAY_MS = 1_000;

/** Identifies the dedicated LISTEN connection in `pg_stat_activity`. */
const LISTENER_APPLICATION_NAME = 'agenttracker_stream';

/**
 * Fans committed events out to live subscribers.
 *
 * A dedicated Postgres connection LISTENs for the notification `appendEvent`
 * emits, reads the committed row by `seq` and hands it to every subscriber. That
 * keeps delivery on the append path: there is no timer and no polling loop, and
 * writes made by another process (the MCP server, another API instance) reach
 * this server's clients too.
 *
 * Deliveries are serialized so subscribers see events in notification order. If
 * the listener connection drops it is reopened after a short delay; events
 * committed while it was down were never notified and are not replayed by the
 * hub.
 */
export class EventStreamHub {
  private readonly db: Database;
  private readonly connectionString: string;
  private readonly reconnectDelayMs: number;
  private readonly subscribers = new Set<StreamSubscriber>();
  private client: Client | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private delivery: Promise<void> = Promise.resolve();
  private started = false;
  private closed = false;

  constructor(db: Database, options: EventStreamHubOptions) {
    this.db = db;
    this.connectionString = options.connectionString;
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  }

  /** True while the LISTEN connection is established. */
  get listening(): boolean {
    return this.client !== null;
  }

  /** Number of live subscribers, used to prove disconnect cleanup. */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Opens the listener connection. The first failure rejects. */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    await this.open();
  }

  /** Registers a subscriber and returns the function that removes it again. */
  subscribe(subscriber: StreamSubscriber): () => void {
    if (this.closed) {
      throw new Error('EventStreamHub: cannot subscribe after the hub was closed');
    }

    this.subscribers.add(subscriber);

    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /** Drops every subscriber and closes the listener connection. */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.subscribers.clear();

    const client = this.client;
    this.client = null;

    if (client !== null) {
      try {
        await client.end();
      } catch (error) {
        console.error('Live stream listener could not be closed cleanly:', error);
      }
    }

    await this.delivery;
  }

  private async open(): Promise<void> {
    const client = new Client({
      connectionString: this.connectionString,
      application_name: LISTENER_APPLICATION_NAME,
    });

    this.client = client;

    client.on('notification', (notification) => {
      if (notification.channel === EVENT_STREAM_CHANNEL) {
        this.enqueue(notification.payload ?? '');
      }
    });

    client.on('error', (error) => {
      if (this.client !== client) {
        return;
      }

      this.client = null;

      if (!this.closed) {
        console.error('Live stream listener connection failed:', error);
        this.scheduleReconnect();
      }
    });

    client.on('end', () => {
      if (this.client !== client) {
        return;
      }

      this.client = null;

      if (!this.closed) {
        this.scheduleReconnect();
      }
    });

    try {
      await client.connect();
      await client.query(`LISTEN ${EVENT_STREAM_CHANNEL}`);

      if (this.closed) {
        if (this.client === client) {
          this.client = null;
        }

        await client.end();
      }
    } catch (error) {
      if (this.client === client) {
        this.client = null;
      }

      try {
        await client.end();
      } catch {
        // The connection may already be gone; the original error is what matters.
      }

      throw error;
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      void this.open().catch((error: unknown) => {
        console.error('Live stream listener reconnect failed:', error);
        this.scheduleReconnect();
      });
    }, this.reconnectDelayMs);

    this.reconnectTimer.unref();
  }

  private enqueue(payload: string): void {
    const seq = Number(payload);

    if (!Number.isSafeInteger(seq) || seq < 1) {
      console.error(`Live stream listener ignored an invalid seq payload: "${payload}"`);
      return;
    }

    this.delivery = this.delivery
      .then(() => this.deliver(seq))
      .catch((error: unknown) => {
        console.error(`Live stream delivery for seq ${seq} failed:`, error);
      });
  }

  private async deliver(seq: number): Promise<void> {
    if (this.closed) {
      return;
    }

    const [row] = await this.db
      .select()
      .from(events)
      .where(eq(events.seq, seq))
      .limit(1);

    if (row === undefined) {
      console.error(`Live stream listener could not read event at seq ${seq}`);
      return;
    }

    const event = toEventJson(row);

    // Copy the set so a subscriber that unsubscribes while being called cannot
    // disturb the iteration.
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(event);
      } catch (error) {
        console.error('Live stream subscriber failed:', error);
      }
    }
  }
}
