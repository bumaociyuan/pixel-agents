/**
 * Types for pi-messenger Crew feed events.
 *
 * Mirrors the FeedEvent type from pi-messenger/feed.ts. Kept separate so
 * this provider has zero runtime dependency on pi-messenger — it only reads
 * the JSONL file on disk.
 */

export type FeedEventType =
  | 'join'
  | 'leave'
  | 'reserve'
  | 'release'
  | 'message'
  | 'commit'
  | 'test'
  | 'edit'
  | 'task.start'
  | 'task.done'
  | 'task.review'
  | 'task.block'
  | 'task.unblock'
  | 'task.reset'
  | 'task.delete'
  | 'task.split'
  | 'task.revise'
  | 'task.revise-tree'
  | 'task.approve'
  | 'task.reject'
  | 'plan.start'
  | 'plan.pass.start'
  | 'plan.pass.done'
  | 'plan.review.start'
  | 'plan.review.done'
  | 'plan.done'
  | 'plan.cancel'
  | 'plan.failed'
  | 'stuck';

export interface FeedEvent {
  ts: string;
  agent: string;
  type: FeedEventType;
  target?: string;
  preview?: string;
}