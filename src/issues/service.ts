import { and, asc, desc, eq, lt } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { events, issues } from '../db/schema.js';
import { appendEvent } from '../events.js';
import type { Actor } from '../events.js';

export const ISSUE_STATUSES = ['backlog', 'todo', 'in_progress', 'done', 'canceled'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const MIN_PRIORITY = 0;
export const MAX_PRIORITY = 4;

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

export const DEFAULT_STATUS: IssueStatus = 'backlog';
export const DEFAULT_PRIORITY = 0;

export const ISSUE_CREATED_EVENT = 'issue.created';

export type Issue = typeof issues.$inferSelect;
export type IssueEvent = typeof events.$inferSelect;

export interface CreateIssueInput {
  readonly title: string;
  readonly body?: string;
  readonly status?: IssueStatus;
  readonly priority?: number;
  readonly assignee?: string | null;
}

export interface ListIssuesOptions {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface IssuePage {
  readonly issues: Issue[];
  readonly nextCursor: string | null;
}

/** The issue.created payload: everything needed to rebuild the projection row. */
export interface IssueSnapshot {
  readonly id: string;
  readonly key: number;
  readonly title: string;
  readonly body: string;
  readonly status: IssueStatus;
  readonly priority: number;
  readonly assignee: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class InvalidCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCursorError';
  }
}

export function isIssueStatus(value: string): value is IssueStatus {
  return (ISSUE_STATUSES as readonly string[]).includes(value);
}

/**
 * Creates the projection row and appends `issue.created` in one transaction.
 *
 * The event carries a full issue snapshot and the projection stores its seq as
 * `last_event_seq`, so `rebuildProjections` can recreate the exact row.
 */
export async function createIssue(
  db: Database,
  actor: Actor,
  input: CreateIssueInput,
): Promise<Issue> {
  return db.transaction(async (tx) => {
    const now = new Date();

    const [created] = await tx
      .insert(issues)
      .values({
        id: crypto.randomUUID(),
        title: input.title,
        body: input.body ?? '',
        status: input.status ?? DEFAULT_STATUS,
        priority: input.priority ?? DEFAULT_PRIORITY,
        assignee: input.assignee ?? null,
        createdAt: now,
        updatedAt: now,
        // Replaced with the real seq below; never visible outside this transaction.
        lastEventSeq: 0,
      })
      .returning();

    if (created === undefined) {
      throw new Error('createIssue: the issues insert returned no row');
    }

    const seq = await appendEvent(tx, {
      actor,
      entityType: 'issue',
      entityId: created.id,
      type: ISSUE_CREATED_EVENT,
      payload: { issue: toIssueSnapshot(created) },
    });

    const [projected] = await tx
      .update(issues)
      .set({ lastEventSeq: seq })
      .where(eq(issues.id, created.id))
      .returning();

    if (projected === undefined) {
      throw new Error('createIssue: the projection update returned no row');
    }

    return projected;
  });
}

/** Newest first. The cursor is opaque to clients. */
export async function listIssues(
  db: Database,
  options: ListIssuesOptions = {},
): Promise<IssuePage> {
  const limit = options.limit ?? DEFAULT_PAGE_SIZE;

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new RangeError(`limit must be an integer between 1 and ${MAX_PAGE_SIZE}`);
  }

  const cursorKey = options.cursor === undefined ? null : decodeCursor(options.cursor);

  const rows = await db
    .select()
    .from(issues)
    .where(cursorKey === null ? undefined : lt(issues.key, cursorKey))
    .orderBy(desc(issues.key))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const hasMore = rows.length > limit;

  return {
    issues: page,
    nextCursor: hasMore && last !== undefined ? encodeCursor(last.key) : null,
  };
}

export async function getIssue(db: Database, id: string): Promise<Issue | null> {
  const [issue] = await db.select().from(issues).where(eq(issues.id, id)).limit(1);
  return issue ?? null;
}

/** The timeline for one issue, oldest first. Null when the issue does not exist. */
export async function listIssueEvents(db: Database, id: string): Promise<IssueEvent[] | null> {
  const issue = await getIssue(db, id);

  if (issue === null) {
    return null;
  }

  return db
    .select()
    .from(events)
    .where(and(eq(events.entityType, 'issue'), eq(events.entityId, id)))
    .orderBy(asc(events.seq));
}

export function toIssueSnapshot(issue: Issue): IssueSnapshot {
  return {
    id: issue.id,
    key: issue.key,
    title: issue.title,
    body: issue.body,
    status: issue.status as IssueStatus,
    priority: issue.priority,
    assignee: issue.assignee,
    createdAt: issue.createdAt.toISOString(),
    updatedAt: issue.updatedAt.toISOString(),
  };
}

function encodeCursor(key: number): string {
  return Buffer.from(String(key), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new InvalidCursorError('cursor is not a valid pagination cursor');
  }

  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');

  if (!/^[1-9][0-9]*$/.test(decoded)) {
    throw new InvalidCursorError('cursor is not a valid pagination cursor');
  }

  const key = Number(decoded);

  if (!Number.isSafeInteger(key)) {
    throw new InvalidCursorError('cursor is out of range');
  }

  return key;
}
