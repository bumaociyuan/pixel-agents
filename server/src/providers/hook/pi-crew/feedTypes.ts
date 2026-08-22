/**
 * Types for pi-crew (baphuongna) run events.
 *
 * Mirrors the TeamEvent format from pi-crew's event-log.ts.
 * Kept separate so this provider has zero runtime dependency on pi-crew —
 * it only reads the JSONL files on disk.
 */

import type { RunLifecycleState } from './piCrewLifecycle.js';

/** pi-crew event types we care about for pixel-agent visualization. */
export type PiCrewEventType =
  // Run lifecycle
  | 'run.created'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  // Task lifecycle
  | 'task.started'
  | 'task.completed'
  | 'task.failed'
  | 'task.needs_attention'
  | 'task.cancelled'
  | 'task.progress'
  | 'task.attention'
  | 'task.parallel_start'
  | 'task.parallel_end'
  // Worker lifecycle
  | 'worker.spawned'
  | 'worker.exit'
  | 'worker.close'
  | 'worker.cancelled'
  | 'worker.spawn_error'
  | 'worker.response_timeout'
  | 'worker.final_drain'
  | 'worker.hard_kill'
  | 'worker.failed'
  | 'worker.terminated';

/** A single event from pi-crew's events.jsonl. */
export interface PiCrewEvent {
  time: string;
  type: PiCrewEventType | string;
  runId: string;
  taskId?: string;
  message?: string;
  data?: Record<string, unknown>;
  metadata?: {
    seq?: number;
    provenance?: string;
    fingerprint?: string;
    parentEventId?: string;
    attemptId?: string;
  };
}

/** Internal state for tracking a single run's event log. */
export interface RunEventState {
  runId: string;
  eventsPath: string;
  cwd: string;
  offset: number;
  lineBuffer: string;
  lifecycle: RunLifecycleState;
}
