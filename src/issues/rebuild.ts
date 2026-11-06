import { asc, gt, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { events, issues } from '../db/schema.js';
import {
  COMMENT_CREATED_EVENT,
  ISSUE_CREATED_EVENT,
  ISSUE_UPDATED_EVENT,
  isIssueStatus,
  MAX_PRIORITY,
  MIN_PRIORITY,
} from './service.js';
import type { IssueEvent, IssueSnapshot } from './service.js';

const REPLAY_BATCH_SIZE = 1_000;

type IssueRow = typeof issues.$inferInsert;

export interface RebuildResult {
  readonly events: number;
  readonly issues: number;
}

/**
 * Truncates the issues projection and replays the event log into it.
 *
 * The truncate and the replay share one transaction: either the projection is
 * fully rebuilt, or it is left untouched. Events are folded in seq order:
 * `issue.created` seeds a row, `issue.updated` applies the fields it carries,
 * and `comment.created` leaves the projection alone because comments are read
 * from the log itself. Event seq order is creation order, so explicitly
 * restoring `key` and the timestamps makes the result identical to the live
 * projection. The issue key sequence is advanced past the restored keys so
 * later creates continue from the right number.
 */
export async function rebuildProjections(db: Database): Promise<RebuildResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`TRUNCATE TABLE ${issues}`);

    const state = new Map<string, IssueRow>();
    let replayed = 0;
    let afterSeq = 0;

    for (;;) {
      const batch = await tx
        .select()
        .from(events)
        .where(gt(events.seq, afterSeq))
        .orderBy(asc(events.seq))
        .limit(REPLAY_BATCH_SIZE);

      if (batch.length === 0) {
        break;
      }

      for (const event of batch) {
        replayed += 1;
        afterSeq = event.seq;

        if (event.entityType !== 'issue') {
          continue;
        }

        applyIssueEvent(state, event);
      }
    }

    const rows = [...state.values()];

    if (rows.length > 0) {
      await tx.insert(issues).values(rows);
    }

    await tx.execute(sql`
      SELECT setval(
        pg_get_serial_sequence('issues', 'key')::regclass,
        COALESCE((SELECT MAX(key) FROM ${issues}), 0) + 1,
        false
      )
    `);

    return { events: replayed, issues: rows.length };
  });
}

function applyIssueEvent(state: Map<string, IssueRow>, event: IssueEvent): void {
  switch (event.type) {
    case ISSUE_CREATED_EVENT: {
      const snapshot = parseIssueSnapshot(event);

      if (state.has(snapshot.id)) {
        throw invalidEvent(event, `duplicate issue.created for issue ${snapshot.id}`);
      }

      state.set(snapshot.id, {
        id: snapshot.id,
        key: snapshot.key,
        title: snapshot.title,
        body: snapshot.body,
        status: snapshot.status,
        priority: snapshot.priority,
        assignee: snapshot.assignee,
        createdAt: new Date(snapshot.createdAt),
        updatedAt: new Date(snapshot.updatedAt),
        lastEventSeq: event.seq,
      });
      return;
    }

    case ISSUE_UPDATED_EVENT: {
      const row = state.get(event.entityId);

      if (row === undefined) {
        throw invalidEvent(event, 'issue.updated arrived before issue.created');
      }

      const changes = parseIssueChanges(event);

      Object.assign(row, changes, { updatedAt: event.at, lastEventSeq: event.seq });
      return;
    }

    case COMMENT_CREATED_EVENT:
      // Comments are derived from the event log and do not shape the issue row.
      return;

    default:
      throw invalidEvent(event, `unsupported issue event type "${event.type}"`);
  }
}

/** The fields an issue.updated event may carry. */
function parseIssueChanges(event: IssueEvent): Record<string, unknown> {
  const keys = Object.keys(event.payload);

  if (keys.length === 0) {
    throw invalidEvent(event, 'issue.updated payload must contain at least one changed field');
  }

  const changes: Record<string, unknown> = {};

  for (const key of keys) {
    switch (key) {
      case 'title':
        changes['title'] = requireString(event.payload, 'title', event, 'payload');
        break;
      case 'body':
        changes['body'] = requireString(event.payload, 'body', event, 'payload');
        break;
      case 'status': {
        const status = requireString(event.payload, 'status', event, 'payload');

        if (!isIssueStatus(status)) {
          throw invalidEvent(event, 'payload.status is not a known status');
        }

        changes['status'] = status;
        break;
      }
      case 'priority': {
        const priority = event.payload['priority'];

        if (
          typeof priority !== 'number' ||
          !Number.isInteger(priority) ||
          priority < MIN_PRIORITY ||
          priority > MAX_PRIORITY
        ) {
          throw invalidEvent(event, 'payload.priority is out of range');
        }

        changes['priority'] = priority;
        break;
      }
      case 'assignee': {
        const assignee = event.payload['assignee'];

        if (assignee !== null && typeof assignee !== 'string') {
          throw invalidEvent(event, 'payload.assignee must be a string or null');
        }

        changes['assignee'] = assignee;
        break;
      }
      default:
        throw invalidEvent(event, `payload.${key} is not an updatable issue field`);
    }
  }

  return changes;
}

function parseIssueSnapshot(event: IssueEvent): IssueSnapshot {
  const raw = event.payload['issue'];

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw invalidEvent(event, 'payload.issue must be an object');
  }

  const value = raw as Record<string, unknown>;
  const path = 'payload.issue';

  const id = requireString(value, 'id', event, path);

  if (id !== event.entityId) {
    throw invalidEvent(event, 'payload.issue.id must match the event entity id');
  }

  const key = value['key'];

  if (typeof key !== 'number' || !Number.isInteger(key) || key < 1) {
    throw invalidEvent(event, 'payload.issue.key must be a positive integer');
  }

  const title = requireString(value, 'title', event, path);
  const body = requireString(value, 'body', event, path);
  const status = requireString(value, 'status', event, path);

  if (!isIssueStatus(status)) {
    throw invalidEvent(event, 'payload.issue.status is not a known status');
  }

  const priority = value['priority'];

  if (
    typeof priority !== 'number' ||
    !Number.isInteger(priority) ||
    priority < MIN_PRIORITY ||
    priority > MAX_PRIORITY
  ) {
    throw invalidEvent(event, 'payload.issue.priority is out of range');
  }

  const assignee = value['assignee'];

  if (assignee !== null && typeof assignee !== 'string') {
    throw invalidEvent(event, 'payload.issue.assignee must be a string or null');
  }

  const createdAt = requireTimestamp(value, 'createdAt', event, path);
  const updatedAt = requireTimestamp(value, 'updatedAt', event, path);

  return {
    id,
    key,
    title,
    body,
    status,
    priority,
    assignee,
    createdAt,
    updatedAt,
  };
}

function requireString(
  value: Record<string, unknown>,
  field: string,
  event: IssueEvent,
  path: string,
): string {
  const candidate = value[field];

  if (typeof candidate !== 'string') {
    throw invalidEvent(event, `${path}.${field} must be a string`);
  }

  return candidate;
}

function requireTimestamp(
  value: Record<string, unknown>,
  field: string,
  event: IssueEvent,
  path: string,
): string {
  const candidate = requireString(value, field, event, path);

  if (Number.isNaN(Date.parse(candidate))) {
    throw invalidEvent(event, `${path}.${field} must be an ISO timestamp`);
  }

  return candidate;
}

function invalidEvent(event: IssueEvent, message: string): Error {
  return new Error(`cannot rebuild issue projection at seq ${event.seq}: ${message}`);
}
