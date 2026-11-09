import type { CreationOutcome, MutationOutcome } from '@poker/contracts';
import { boolean, jsonb, pgTable, primaryKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import type { MembershipStatus, StoredTableSession } from '../aggregate.js';
export const localUsers = pgTable('local_users', {
  id: uuid('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  displayName: text('display_name'),
});
export const tableSessions = pgTable('table_sessions', {
  id: uuid('id').primaryKey(),
  ownerUserId: uuid('owner_user_id').notNull().references(() => localUsers.id),
  /** Any stored version; read it through `upgradeTableSession`. */
  aggregate: jsonb('aggregate').$type<StoredTableSession>().notNull(),
  /** True exactly while the table has scheduled work (`hasScheduledWork`), written with each commit; startup loads only these. */
  loadAtStartup: boolean('load_at_startup').notNull().default(false),
});
/** The membership index: one row per human Participant, mirroring its aggregate binding. */
export const tableMemberships = pgTable('table_memberships', {
  userId: uuid('user_id').notNull().references(() => localUsers.id),
  tableSessionId: uuid('table_session_id').notNull().references(() => tableSessions.id),
  participantId: text('participant_id').notNull(),
  status: text('status').$type<MembershipStatus>().notNull(),
}, table => [primaryKey({ columns: [table.userId, table.tableSessionId] }), unique().on(table.tableSessionId, table.participantId)]);

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

/** Successful derived evaluations are independent of authoritative poker records. */
export const analysisEvaluations = pgTable('analysis_evaluations', {
  fingerprint: text('fingerprint').primaryKey(),
  requestId: uuid('request_id').notNull().unique(),
  tableSessionId: uuid('table_session_id').notNull().references(() => tableSessions.id),
  participantId: text('participant_id').notNull(),
  result: jsonb('result').$type<Extract<import('@poker/contracts').DecisionAnalysis, { status: 'complete' }>>().notNull(),
});
/** Successful scores retain their evaluation identity without entering poker records. */
export const analysisScores = pgTable('analysis_scores', {
  fingerprint: text('fingerprint').primaryKey(),
  requestId: uuid('request_id').notNull().unique(),
  tableSessionId: uuid('table_session_id').notNull().references(() => tableSessions.id),
  participantId: text('participant_id').notNull(),
  result: jsonb('result').$type<Extract<import('@poker/contracts').DecisionAnalysis, { status: 'complete' }>>().notNull(),
});
