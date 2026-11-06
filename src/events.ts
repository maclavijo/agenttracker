import type { Executor } from './db/client.js';
import { events } from './db/schema.js';

/** Attribution is mandatory for every event. */
export type ActorType = 'human' | 'agent';

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
}

/**
 * Appends one row to the event log and returns its sequence number.
 *
 * Pass a transaction (`Executor`) to make the append atomic with the projection
 * write that consumes the returned `seq`.
 */
export async function appendEvent(executor: Executor, input: AppendEventInput): Promise<number> {
  const [row] = await executor
    .insert(events)
    .values({
      actorType: input.actor.type,
      actorId: input.actor.id,
      entityType: input.entityType,
      entityId: input.entityId,
      type: input.type,
      payload: input.payload,
    })
    .returning({ seq: events.seq });

  if (row === undefined) {
    throw new Error('appendEvent: the events insert returned no row');
  }

  return row.seq;
}
