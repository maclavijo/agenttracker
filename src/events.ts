import { sql } from 'drizzle-orm';
import type { Executor } from './db/client.js';
import { events } from './db/schema.js';

/**
 * The Postgres notification channel the live stream listens on. Appends publish
 * the new `seq` on this channel; see `appendEvent`.
 */
export const EVENT_STREAM_CHANNEL = 'agenttracker_events';

export const ACTOR_TYPES = ['human', 'agent'] as const;

/** Attribution is mandatory for every event. */
export type ActorType = (typeof ACTOR_TYPES)[number];

export function isActorType(value: string): value is ActorType {
  return (ACTOR_TYPES as readonly string[]).includes(value);
}

export interface Actor {
  readonly type: ActorType;
  readonly id: string;
}

export interface AppendEventInput {
  readonly actor: Actor;
  readonly entityType: string;
  readonly entityId: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  /**
   * Event timestamp. Passing the same instant that shapes a projection lets a
   * rebuild restore that projection field exactly.
   */
  readonly at?: Date;
}

export interface AppendedEvent {
  readonly id: number;
  readonly seq: number;
  readonly at: Date;
}

/** One committed event, in the JSON shape the HTTP API returns. */
export type EventRecord = typeof events.$inferSelect;

export interface EventJson {
  readonly id: number;
  readonly at: string;
  readonly actorType: string;
  readonly actorId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly seq: number;
}

export function toEventJson(event: EventRecord): EventJson {
  return {
    id: event.id,
    at: event.at.toISOString(),
    actorType: event.actorType,
    actorId: event.actorId,
    entityType: event.entityType,
    entityId: event.entityId,
    type: event.type,
    payload: event.payload,
    seq: event.seq,
  };
}

/**
 * Appends one row to the event log and returns its id, sequence number and
 * timestamp.
 *
 * Pass a transaction (`Executor`) to make the append atomic with the projection
 * write that consumes the returned `seq`.
 *
 * The append also publishes its `seq` on `EVENT_STREAM_CHANNEL`. Postgres
 * delivers notifications only when the surrounding transaction commits, so a
 * rolled-back append never reaches the live stream and the HTTP server, the MCP
 * server and any other process sharing the database all fan out the same event.
 */
export async function appendEvent(
  executor: Executor,
  input: AppendEventInput,
): Promise<AppendedEvent> {
  const [row] = await executor
    .insert(events)
    .values({
      at: input.at ?? new Date(),
      actorType: input.actor.type,
      actorId: input.actor.id,
      entityType: input.entityType,
      entityId: input.entityId,
      type: input.type,
      payload: input.payload,
    })
    .returning({ id: events.id, seq: events.seq, at: events.at });

  if (row === undefined) {
    throw new Error('appendEvent: the events insert returned no row');
  }

  await executor.execute(sql`SELECT pg_notify(${EVENT_STREAM_CHANNEL}, ${String(row.seq)})`);

  return row;
}
