import type { Executor } from './db/client.js';
import { events } from './db/schema.js';

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

/**
 * Appends one row to the event log and returns its id, sequence number and
 * timestamp.
 *
 * Pass a transaction (`Executor`) to make the append atomic with the projection
 * write that consumes the returned `seq`.
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

  return row;
}
