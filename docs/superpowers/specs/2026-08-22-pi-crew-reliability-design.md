# pi-crew Reliability and Multi-Project Design

## Goal

Make the pi-crew integration reliable under concurrent runs, multiple projects, process restarts, partial JSONL writes, network failures, and workspace changes while preserving the shared `HookProvider` → `AgentEvent` → `AgentRuntime` architecture.

The change must not alter Claude or Pi Agent behavior. Existing pi-crew users retain planner, worker, and reviewer characters, but their internal identities and lifecycle handling become deterministic.

## Current Problems

The current provider has several correctness issues:

- `task.started` can omit `SessionStart` because the watcher inserts the agent into `knownAgents` before the mapper checks it.
- Session IDs contain only the agent name, so projects, runs, planners, and workers can collide.
- A terminal event for one task closes an agent that may still own other active tasks.
- Worker failures without task terminal events can leave orphan characters.
- Completed logs replay from offset zero after Pixel Agents restarts.
- JSONL offsets advance before hook delivery succeeds; delivery is fire-and-forget and unordered.
- Fixed-size byte reads can split UTF-8 code points, and truncation or rotation can stall a run permanently.
- VS Code multi-root folders are not passed into the pi-crew watcher.
- Area mappings use basename as identity, merging unrelated projects with the same directory name.
- Auto-room guesses seats from furniture type prefixes instead of using the layout's canonical seat rules.

## Architecture

The pi-crew input path remains compatible with the shared runtime:

```text
.crew/state/runs/<runId>/events.jsonl
  -> incremental JSONL reader
  -> per-run lifecycle state machine
  -> per-run ordered outbox
  -> POST /api/hooks/pi-crew
  -> HookEventHandler
  -> AgentStateStore
```

The implementation is divided into four isolated units:

1. Project identity and scope management.
2. Incremental JSONL reading and checkpoints.
3. Run/task/agent lifecycle mapping.
4. Ordered, retrying hook delivery.

Each unit exposes a narrow interface and is independently testable.

## Project Identity and Scope

Introduce a shared project description:

```ts
interface ProjectScope {
  key: string;
  path: string;
  displayName: string;
}
```

`key` is derived from the canonical absolute path using a stable platform-aware encoding. Paths are resolved, realpathed when possible, and case-folded on case-insensitive platforms. Directory basename is display metadata, never a foreign key.

`HookProvider` gains an optional capability:

```ts
setProjectScopes?(scopes: readonly ProjectScope[]): void;
```

- Standalone supplies the startup working directory.
- VS Code supplies every workspace folder.
- VS Code updates scopes on workspace-folder additions and removals.
- The watcher replaces its scope set atomically, deduplicates aliases and symlinks, and drops run state belonging to removed scopes after orderly shutdown.

## Agent and Tool Identity

All pi-crew identities are namespaced:

```text
session: pi-crew:<projectKey>:<runId>:<agentKey>
planner: pi-crew:<projectKey>:<runId>:planner
tool:    crew-task:<runId>:<taskId>:<attemptId-or-default>
plan:    crew-plan:<runId>
```

`agentKey` is selected in this order:

1. Stable agent or worker identifier from the event.
2. Pane/process identifier when supplied.
3. `<role>:<taskId>` fallback.

Role alone is never an identity. The `RunEventState.runId` derived from the discovered log directory is authoritative; a mismatched `event.runId` is diagnosed and cannot redirect events into another run.

## Lifecycle State Model

The watcher and mapper no longer mutate overlapping `knownAgents`, `taskAgents`, or `taskOwners` collections. A single state machine owns all transitions:

```ts
interface RunLifecycleState {
  project: ProjectScope;
  runId: string;
  lifecycle: 'active' | 'completed' | 'failed' | 'cancelled';
  planner: AgentLifecycleState;
  agents: Map<string, AgentLifecycleState>;
  tasks: Map<string, TaskLifecycleState>;
}

interface AgentLifecycleState {
  key: string;
  sessionId: string;
  displayName: string;
  role: string;
  introduced: boolean;
  lifecycle: 'active' | 'blocked' | 'exited';
  activeTaskIds: Set<string>;
}

interface TaskLifecycleState {
  taskId: string;
  agentKey: string;
  attemptId?: string;
  toolId: string;
  lifecycle: 'announced' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';
}
```

### Transition Rules

- `run.created` introduces only that run's planner and starts its plan tool.
- `task.parallel_start` announces tasks and may introduce unique agents idempotently.
- `task.started` resolves the owner, releases a previous owner on reassignment, emits `SessionStart` once, then emits `ToolStart` once.
- `task.progress` updates only a known non-terminal task. Progress after attention unblocks the agent before applying activity.
- `task.needs_attention` and `task.attention` retain the task and session in a blocked state.
- `task.completed` emits `ToolEnd`, removes the task from the owner, and emits `SessionEnd` only when the owner has no other active tasks.
- `task.failed` emits `ToolEnd` and a failed terminal reason. It does not masquerade as a permission request.
- `task.cancelled` ends the tool and applies the same last-active-task rule.
- Worker exit, close, spawn error, response timeout, final drain, or hard kill ends all tasks owned by that worker and then ends its session, even if no task terminal event follows.
- Run completion, failure, or cancellation ends the planner and every still-live worker exactly once.
- Pruning releases memory and checkpoints only. It never emits lifecycle events already emitted by a terminal transition.
- Duplicate starts, progress events, task terminals, worker terminals, and run terminals are idempotent.

The existing protocol has no durable failed visual state. Failed tasks therefore end with `toolEnd` followed by `sessionEnd(reason)`. Adding a new failure animation is outside this design.

## Incremental JSONL Reader

Each run reader tracks:

- committed byte offset;
- current read offset;
- file identity (`dev`/`ino`, with a portable fallback fingerprint);
- UTF-8 `StringDecoder` state;
- incomplete trailing line;
- queued parsed events;
- recently seen event IDs.

Rules:

- Only newline-terminated complete records are parsed and eligible for checkpointing.
- Reads continue until available complete data is consumed; a 64 KiB chunk is an implementation detail, not an event limit.
- `StringDecoder` preserves Chinese text, emoji, and other multi-byte characters across chunk boundaries.
- Malformed complete lines produce rate-limited diagnostics and do not block later valid lines.
- File descriptors are always closed in `finally` blocks.
- If size becomes smaller than the committed offset, or file identity changes, the decoder and offsets reset safely.
- Event IDs prefer `metadata.fingerprint`, then `runId + metadata.seq`, then a stable hash of normalized event content.

### Startup Policy

- A stored checkpoint resumes from its committed offset when file identity is compatible.
- A run with no checkpoint and an active final event is read from zero to reconstruct the office.
- A run with no checkpoint whose last complete event is terminal starts at EOF and is not replayed.
- Terminal detection reads complete lines without assuming the final record is under 4 KiB.

Checkpoints are stored atomically in Pixel Agents state, never inside `.crew`. They include file identity, committed offset, and a bounded recent-event-ID window.

## Ordered Outbox

Every parsed source event becomes an outbox item:

```ts
interface OutboxItem {
  eventId: string;
  startOffset: number;
  endOffset: number;
  payloads: Array<{ idempotencyKey: string; body: Record<string, unknown> }>;
}
```

Payloads for one run are delivered serially. Different runs may drain concurrently.

- A 2xx response is success.
- Network errors, timeouts, HTTP 408, 429, and 5xx retry with bounded exponential backoff and jitter.
- Other 4xx responses are recorded as permanent delivery errors and do not retry indefinitely.
- Requests have an explicit timeout and are aborted when it expires.
- Idempotency keys use `<eventId>:<payloadIndex>` and are passed to the hook ingress.
- The hook ingress retains a bounded provider/idempotency-key cache to ignore duplicate delivery.
- The checkpoint advances only after every payload for the source event succeeds or is explicitly classified as permanent failure with diagnostics.
- `stop()` stops discovery, drains pending work for a bounded interval, then aborts remaining requests and timers.

## Area Mapping and Configuration Migration

Add a versioned, top-level shared project-area mapping keyed by `ProjectScope.key`. Adapter-specific legacy `areaMappings` remain readable migration sources but are no longer duplicated on every write.

Lookup order during the compatibility period is:

1. New stable project key.
2. Legacy canonical absolute path.
3. VS Code workspace-folder name.
4. Directory basename.

New writes use only the stable project key.

Migration rules:

- Full-path legacy keys convert directly to stable project keys.
- A legacy basename/name with one matching scope migrates to that project.
- An ambiguous basename is copied to every matching project and emits a migration warning; no mapping is silently discarded.
- Existing user-created Area labels and tiles are preserved.
- The first project may retain an existing basename Area. Later projects with the same display name receive `<name> · <shortProjectHash>`.
- Migration is versioned and idempotent.

`preferredArea` remains an explicit single-area override for compatibility. Normal seat selection uses the project key and the complete list of mapped areas, so multi-area mappings are not truncated.

## Canonical Seat Derivation

Move UI-independent seat-tile derivation into a shared core layout helper. Both webview layout serialization and server auto-room consume it.

The helper derives seat tiles from furniture catalog metadata, including category, footprint, rotation, and background tiles. UI-only facing and desk-bias logic remains in the webview.

Auto-room behavior:

- Select at most four real, currently unassigned seat tiles.
- Never overwrite an existing Area tile.
- Support multi-tile chairs/couches according to catalog metadata.
- Ignore unknown or non-seat furniture.
- Repair `areaTiles` dimensions before assignment.

## Diagnostics and Error Handling

- Replace empty catches with categorized, rate-limited diagnostics.
- Diagnostics identify project, run, file, offset, and event ID without logging hook bearer tokens.
- Temporary missing files remain normal and quiet.
- Persistent permission/read errors, malformed records, permanent HTTP errors, migration ambiguity, and checkpoint corruption are observable.
- A failure in one run cannot stop polling or delivery for another run.

## TDD Strategy

Implementation follows strict RED-GREEN-REFACTOR cycles. Each behavior receives a failing test before production changes.

### Lifecycle Tests

- A lone `task.started` emits `SessionStart` followed by `ToolStart`.
- Same agent names in two projects or runs produce distinct sessions.
- Concurrent planners do not overlap.
- Parallel tasks with equal roles produce unique identities.
- Finishing one of an agent's active tasks does not end the session.
- Reassigning a task cleans the previous owner and activates the new owner.
- Failed tasks do not emit permission requests.
- Attention followed by progress unblocks the agent.
- Worker abnormal exit cleans tasks and session without a task terminal event.
- Duplicate terminal events are idempotent.
- Run terminal followed by prune does not duplicate cleanup.

### Reader and Delivery Tests

- Complete, partial, multiple, malformed, and larger-than-64-KiB records.
- Chinese and emoji code points crossing chunk boundaries.
- Truncation, same-path replacement, temporary disappearance, and rotation.
- Active-run reconstruction, completed-run skip, and checkpoint resume.
- Strict SessionStart/ToolStart and ToolEnd/SessionEnd order.
- Timeout and retry behavior for network, 408, 429, and 5xx errors.
- Permanent 4xx handling and idempotent retry after a lost response.
- Stop/drain/abort behavior and file-descriptor cleanup.

### Project and Area Tests

- Initial and dynamically changed VS Code multi-root scopes.
- Standalone cwd scope.
- Canonical path and symlink deduplication.
- Same-basename projects remain distinct.
- Legacy unambiguous and ambiguous migration without data loss.
- Migration idempotency and compatibility lookup order.
- Canonical seat derivation for chairs, multi-tile couches, rotations, background tiles, and non-seat furniture.
- Auto-room respects existing Area tiles and the four-seat limit.

### Integration and Regression Tests

- JSONL → outbox → HTTP hook → `AgentStateStore` lifecycle.
- Existing Claude and Pi Agent suites remain unchanged and passing.
- Relevant standalone and VS Code Playwright scenarios cover appearance, blocked state, completion, removal, multi-root placement, and restart behavior.

## Delivery Order

1. Add failing lifecycle identity and P0 SessionStart tests.
2. Introduce the single run lifecycle state machine.
3. Add failing reader boundary, truncation, and history-policy tests.
4. Implement the incremental reader and checkpoint model.
5. Add failing delivery-order, retry, and idempotency tests.
6. Implement the ordered outbox and ingress deduplication.
7. Add failing project-scope and multi-root tests.
8. Implement project-scope propagation and dynamic replacement.
9. Add failing migration and same-basename tests.
10. Implement versioned shared project-area mappings.
11. Add failing canonical-seat tests.
12. Extract shared seat derivation and update auto-room/webview consumers.
13. Add integration and E2E coverage.
14. Run type checks, lint, all unit tests, package-contract checks, and relevant E2E tests.

## Non-Goals

- Changing Claude or Pi Agent lifecycle semantics.
- Adding a new failed-character animation or wire-protocol failure status.
- Modifying pi-crew files or requiring a runtime dependency on pi-crew.
- Replacing the shared hook ingress for all providers.
- Guaranteeing exactly-once delivery across arbitrary filesystem and process corruption; the target is deterministic idempotent at-least-once delivery within retained checkpoints.

## Acceptance Criteria

- No project/run/agent identity collisions.
- No ToolStart before SessionStart.
- No active session closes while it still owns another active task.
- Worker and run abnormal terminals leave no orphan characters.
- Completed history does not replay after restart.
- Valid JSONL events survive UTF-8 boundaries, large records, truncation, and rotation.
- Retriable delivery failures preserve source order and do not lose events.
- VS Code multi-root and standalone scopes are explicit and dynamically correct.
- Same-basename projects keep independent Area mappings and seats.
- Auto-room uses the same seat truth as the webview.
- Migration preserves legacy mappings without silent loss.
- Full type, lint, unit, package, and targeted E2E verification is clean.
