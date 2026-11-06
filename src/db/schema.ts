import {
  bigint,
  bigserial,
  index,
  jsonb,
  pgTable,
  serial,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const events = pgTable(
  'events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    seq: bigserial('seq', { mode: 'number' }).notNull().unique(),
  },
  (table) => [index('events_entity_seq_idx').on(table.entityType, table.entityId, table.seq)],
);

export const issues = pgTable('issues', {
  id: text('id').primaryKey(),
  key: serial('key').notNull().unique(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  status: text('status').notNull(),
  priority: smallint('priority').notNull(),
  assignee: text('assignee'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  lastEventSeq: bigint('last_event_seq', { mode: 'number' }).notNull(),
});
