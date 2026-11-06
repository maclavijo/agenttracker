import { asc, gt, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { events, issues } from '../db/schema.js';
import {
  ISSUE_CREATED_EVENT,
  isIssueStatus,
  MAX_PRIORITY,
  MIN_PRIORITY,
} from './service.js';
import type { IssueEvent, IssueSnapshot } from './service.js';

const REPLAY_BATCH_SIZE = 1_000;

export interface RebuildResult {
  readonly events: number;
  readonly issues: number;
}

/**
 * Truncates the issues projection and replays the event log into it.
 *
 * The truncate and the replay share one transaction: either the projection is
 * fully rebuilt, or it is left untouched. Event seq order is creation order, so
 * explicitly restoring `key` and the timestamps makes the result identical to
 * the live projection. The issue key sequence is advanced past the restored
 * keys so later creates continue from the right number.
 */
export async function rebuildProjections(db: Database): Promise<RebuildResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`TRUNCATE TABLE ${issues}`);

    let replayed = 0;
    let rebuilt = 0;
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

      const rows: (typeof issues.$inferInsert)[] = [];

      for (const event of batch) {
        replayed += 1;
        afterSeq = event.seq;

        if (event.entityType !== 'issue') {
          continue;
        }

        rows.push(projectionRow(event));
      }

      if (rows.length > 0) {
        await tx.insert(issues).values(rows);
        rebuilt += rows.length;
      }
    }

    await tx.execute(sql`
      SELECT setval(
        pg_get_serial_sequence('issues', 'key')::regclass,
        COALESCE((SELECT MAX(key) FROM ${issues}), 0) + 1,
        false
      )
    `);

    return { events: replayed, issues: rebuilt };
  });
}

function projectionRow(event: IssueEvent): typeof issues.$inferInsert {
  if (event.type !== ISSUE_CREATED_EVENT) {
    throw new Error(
      `cannot rebuild issue projection: unsupported event type "${event.type}" at seq ${event.seq}`,
    );
  }

  const snapshot = parseIssueSnapshot(event);

  return {
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
  };
}

function parseIssueSnapshot(event: IssueEvent): IssueSnapshot {
  const raw = event.payload['issue'];

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw invalidPayload(event, 'payload.issue must be an object');
  }

  const value = raw as Record<string, unknown>;

  const id = requireString(value, 'id', event);

  if (id !== event.entityId) {
    throw invalidPayload(event, 'payload.issue.id must match the event entity id');
  }

  const key = value['key'];

  if (typeof key !== 'number' || !Number.isInteger(key) || key < 1) {
    throw invalidPayload(event, 'payload.issue.key must be a positive integer');
  }

  const title = requireString(value, 'title', event);
  const body = requireString(value, 'body', event);
  const status = requireString(value, 'status', event);

  if (!isIssueStatus(status)) {
    throw invalidPayload(event, 'payload.issue.status is not a known status');
  }

  const priority = value['priority'];

  if (
    typeof priority !== 'number' ||
    !Number.isInteger(priority) ||
    priority < MIN_PRIORITY ||
    priority > MAX_PRIORITY
  ) {
    throw invalidPayload(event, 'payload.issue.priority is out of range');
  }

  const assignee = value['assignee'];

  if (assignee !== null && typeof assignee !== 'string') {
    throw invalidPayload(event, 'payload.issue.assignee must be a string or null');
  }

  const createdAt = requireTimestamp(value, 'createdAt', event);
  const updatedAt = requireTimestamp(value, 'updatedAt', event);

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
): string {
  const candidate = value[field];

  if (typeof candidate !== 'string') {
    throw invalidPayload(event, `payload.issue.${field} must be a string`);
  }

  return candidate;
}

function requireTimestamp(
  value: Record<string, unknown>,
  field: string,
  event: IssueEvent,
): string {
  const candidate = requireString(value, field, event);

  if (Number.isNaN(Date.parse(candidate))) {
    throw invalidPayload(event, `payload.issue.${field} must be an ISO timestamp`);
  }

  return candidate;
}

function invalidPayload(event: IssueEvent, message: string): Error {
  return new Error(`cannot rebuild issue projection at seq ${event.seq}: ${message}`);
}
