import type { CreationOutcome, MutationOutcome } from '@poker/contracts';
import { jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import type { PersistedTableSession } from '../aggregate.js';
export const localUsers = pgTable('local_users', {
  id: uuid('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
});
export const tableSessions = pgTable('table_sessions', {
  id: uuid('id').primaryKey(),
  ownerUserId: uuid('owner_user_id').notNull().references(() => localUsers.id),
  aggregate: jsonb('aggregate').$type<PersistedTableSession>().notNull(),
});

export const creationRequests = pgTable('creation_requests', {
  userId: uuid('user_id').notNull().references(() => localUsers.id),
  requestId: text('request_id').notNull(),
  fingerprint: text('fingerprint').notNull(),
  outcome: jsonb('outcome').$type<CreationOutcome>().notNull(),
}, table => [primaryKey({ columns: [table.userId, table.requestId] })]);

export const processedRequests = pgTable('processed_requests', {
  tableSessionId: uuid('table_session_id').notNull().references(() => tableSessions.id),
  requestId: text('request_id').notNull(),
  fingerprint: text('fingerprint').notNull(),
  outcome: jsonb('outcome').$type<MutationOutcome>().notNull(),
}, table => [primaryKey({ columns: [table.tableSessionId, table.requestId] })]);
