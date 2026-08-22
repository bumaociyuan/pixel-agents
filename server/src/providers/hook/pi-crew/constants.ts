/** pi-crew (baphuongna) provider constants. */

/** Provider id used in the registry and hook endpoint. */
export const PI_CREW_PROVIDER_ID = 'pi-crew';

/** Display name shown in the UI. */
export const PI_CREW_DISPLAY_NAME = 'pi-crew';

/** Poll interval (ms) for the feed.jsonl watcher. Crew events are less
 *  frequent than Claude tool calls, so a slower poll is fine. */
export const PI_CREW_FEED_POLL_MS = 2000;

/** Per-request deadline for the reliable pi-crew hook outbox. */
export const PI_CREW_HOOK_REQUEST_TIMEOUT_MS = 10_000;

/** Maximum attempts for a retryable hook delivery before it remains pending for a later poll. */
export const PI_CREW_HOOK_MAX_ATTEMPTS = 5;

/** Initial exponential-backoff delay for retryable hook delivery. */
export const PI_CREW_HOOK_BACKOFF_BASE_MS = 250;

/** Bound used while draining a watcher during shutdown. */
export const PI_CREW_HOOK_DRAIN_TIMEOUT_MS = 5_000;

/** State subdirectory below Pixel Agents' local state root for durable pi-crew reads. */
export const PI_CREW_CHECKPOINTS_DIR = 'pi-crew/checkpoints';

/** Number of source event IDs retained to suppress replays after file recovery. */
export const PI_CREW_RECENT_EVENT_IDS_MAX = 512;

/** How far back to read feed.jsonl on first poll (bytes from end of file).
 *  Enough to catch the last few events without replaying the whole history. */
export const PI_CREW_FEED_INITIAL_TAIL_BYTES = 32768;

/** Hook event names used in the raw event payloads POSTed to the hook endpoint.
 *  These are the pi-crew (baphuongna) equivalents of Claude's PreToolUse, Stop, etc. */
export const PI_CREW_HOOK_EVENTS = {
  SESSION_START: 'CrewSessionStart',
  SESSION_END: 'CrewSessionEnd',
  TASK_START: 'CrewTaskStart',
  TASK_DONE: 'CrewTaskDone',
  TASK_BLOCK: 'CrewTaskBlock',
  TASK_UNBLOCK: 'CrewTaskUnblock',
  PLAN_START: 'CrewPlanStart',
  PLAN_DONE: 'CrewPlanDone',
  PROGRESS: 'CrewProgress',
} as const;

/** Tool names reported to the office for pi-crew agent activities. */
export const PI_CREW_TOOL_NAMES = {
  TASK: 'CrewTask',
  PLAN: 'CrewPlan',
  REVIEW: 'CrewReview',
} as const;
