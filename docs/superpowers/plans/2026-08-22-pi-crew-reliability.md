# pi-crew Reliability and Multi-Project Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pi-crew sessions collision-free, lifecycle-correct, restart-safe, ordered, retryable, multi-root aware, and consistently placed into project Areas using the canonical seat model.

**Architecture:** Split pi-crew ingestion into project identity, an incremental JSONL reader, a single per-run lifecycle state machine, and a per-run ordered outbox. Preserve the existing HTTP hook ingress and normalized `AgentEvent` runtime boundary while moving shared project/seat primitives into `core`.

**Tech Stack:** TypeScript 5.9, Node.js 20+, Fastify 5, React 19, Vitest 4, Playwright, npm workspaces.

## Global Constraints

- Preserve Claude and Pi Agent lifecycle behavior.
- Follow strict RED-GREEN-REFACTOR: every production behavior needs a test observed failing first.
- Do not modify `.crew` files or add a runtime dependency on pi-crew.
- Use normalized project paths as identity; basename is display metadata only.
- Keep the shared `HookProvider` → `AgentEvent` → `AgentRuntime` boundary.
- Use conventional Chinese commit messages and do not stage unrelated existing changes.
- Keep checkpoint writes atomic and store them under Pixel Agents state.
- Do not log hook bearer tokens.

## File Structure

- Create `core/src/projectScope.ts`: canonical project identity and `ProjectScope`.
- Create `core/src/layout/seatTiles.ts`: UI-independent seat-tile derivation.
- Create `server/src/providers/hook/pi-crew/piCrewLifecycle.ts`: the only run/task/agent state machine.
- Create `server/src/providers/hook/pi-crew/jsonlReader.ts`: incremental UTF-8-safe JSONL reading and file identity.
- Create `server/src/providers/hook/pi-crew/piCrewCheckpointStore.ts`: atomic checkpoint persistence.
- Create `server/src/providers/hook/pi-crew/hookOutbox.ts`: ordered HTTP delivery, retry, timeout, and drain.
- Modify `server/src/providers/hook/pi-crew/piCrewFeedWatcher.ts`: compose scopes, readers, lifecycle, checkpoints, and outboxes.
- Modify `server/src/providers/hook/pi-crew/piCrew.ts`: provider registration and normalization only.
- Modify `server/src/providers/hook/pi-agent/autoRoom.ts`: versioned project-area mapping and canonical seat use.
- Modify `core/src/provider.ts`, `server/src/cli.ts`, and `adapters/vscode/PixelAgentsViewProvider.ts`: optional project scopes.
- Modify `server/src/httpServer.ts`: bounded idempotency-key deduplication.
- Modify `webview-ui/src/office/layout/layoutSerializer.ts`: consume shared seat tiles.
- Add focused Vitest files for every new unit and extend provider/integration tests.

---

### Task 1: Stable Project Identity

**Files:**

- Create: `core/src/projectScope.ts`
- Modify: `core/src/index.ts`
- Test: `server/__tests__/projectScope.test.ts`

**Interfaces:**

- Produces: `ProjectScope`, `canonicalizeProjectPath(path: string): string`, `projectKeyFromPath(path: string): string`, `createProjectScope(path: string, displayName?: string): ProjectScope`, `dedupeProjectScopes(scopes: readonly ProjectScope[]): ProjectScope[]`.

- [ ] **Step 1: Write failing identity tests**

```ts
it('keeps same-basename projects distinct', () => {
  expect(projectKeyFromPath('/a/frontend')).not.toBe(projectKeyFromPath('/b/frontend'));
});

it('deduplicates normalized aliases', () => {
  const a = createProjectScope('/tmp/work/../work');
  const b = createProjectScope('/tmp/work');
  expect(dedupeProjectScopes([a, b])).toHaveLength(1);
});
```

- [ ] **Step 2: Run RED**

Run: `npx vitest run server/__tests__/projectScope.test.ts`

Expected: FAIL because `core/src/projectScope.ts` does not exist.

- [ ] **Step 3: Implement stable keys**

Use `path.resolve`, `fs.realpathSync.native` when the path exists, platform case-folding for Windows, and a SHA-256 base64url digest truncated to 16 characters:

```ts
export interface ProjectScope {
  key: string;
  path: string;
  displayName: string;
}

export function projectKeyFromPath(input: string): string {
  return `path:${createHash('sha256').update(canonicalizeProjectPath(input)).digest('base64url').slice(0, 16)}`;
}
```

- [ ] **Step 4: Run GREEN and regression types**

Run: `npx vitest run server/__tests__/projectScope.test.ts && npm run check-types`

Expected: PASS and exit 0.

- [ ] **Step 5: Commit**

```bash
git add core/src/projectScope.ts core/src/index.ts server/__tests__/projectScope.test.ts
git commit -m "feat(core): 添加稳定项目身份"
```

### Task 2: Single pi-crew Lifecycle State Machine

**Files:**

- Create: `server/src/providers/hook/pi-crew/piCrewLifecycle.ts`
- Modify: `server/src/providers/hook/pi-crew/feedTypes.ts`
- Modify: `server/src/providers/hook/pi-crew/piCrew.ts`
- Test: `server/__tests__/piCrewLifecycle.test.ts`
- Test: `server/__tests__/piCrew.test.ts`

**Interfaces:**

- Consumes: `ProjectScope` from Task 1 and existing `PiCrewEvent`.
- Produces: `type HookPayload = Record<string, unknown>`, `createRunLifecycle(project: ProjectScope, runId: string, cwd: string): RunLifecycleState`, `applyPiCrewEvent(state: RunLifecycleState, event: PiCrewEvent): HookPayload[]`.

- [ ] **Step 1: Write failing P0 and collision tests**

```ts
it('introduces an agent before starting its first task', () => {
  const state = createRunLifecycle(project('/a/app'), 'run-1', '/a/app');
  const payloads = applyPiCrewEvent(state, taskStarted('t1', 'RedMoon'));
  expect(payloads.map((p) => p.hook_event_name)).toEqual(['CrewSessionStart', 'CrewTaskStart']);
});

it('namespaces equal agent names by project and run', () => {
  const a = applyPiCrewEvent(
    createRunLifecycle(project('/a/app'), 'r1', '/a/app'),
    taskStarted('t1', 'RedMoon'),
  );
  const b = applyPiCrewEvent(
    createRunLifecycle(project('/b/app'), 'r1', '/b/app'),
    taskStarted('t1', 'RedMoon'),
  );
  expect(a[0].session_id).not.toBe(b[0].session_id);
});
```

- [ ] **Step 2: Run RED**

Run: `npx vitest run server/__tests__/piCrewLifecycle.test.ts`

Expected: FAIL because lifecycle exports do not exist.

- [ ] **Step 3: Implement state and deterministic identity**

Define `RunLifecycleState`, `AgentLifecycleState`, and `TaskLifecycleState` exactly as the design spec. Build IDs from `project.key`, authoritative `state.runId`, and a sanitized agent key. Make `applyPiCrewEvent` the only mutator; remove watcher-side `knownAgents`, `taskAgents`, and unused `taskOwners` writes.

- [ ] **Step 4: Add failing multi-task and reassignment tests**

```ts
it('keeps a session until its final active task ends', () => {
  const state = run();
  applyPiCrewEvent(state, taskStarted('t1', 'A'));
  applyPiCrewEvent(state, taskStarted('t2', 'A'));
  expect(applyPiCrewEvent(state, taskCompleted('t1')).some(isSessionEnd)).toBe(false);
  expect(applyPiCrewEvent(state, taskCompleted('t2')).some(isSessionEnd)).toBe(true);
});

it('releases the old owner when a task is reassigned', () => {
  const state = run();
  applyPiCrewEvent(state, taskStarted('t1', 'A'));
  const payloads = applyPiCrewEvent(state, taskStarted('t1', 'B', 'attempt-2'));
  expect(payloads.map(eventName)).toEqual([
    'CrewTaskDone',
    'CrewSessionEnd',
    'CrewSessionStart',
    'CrewTaskStart',
  ]);
});
```

- [ ] **Step 5: Run RED for lifecycle edges**

Run: `npx vitest run server/__tests__/piCrewLifecycle.test.ts`

Expected: FAIL on last-task and reassignment assertions.

- [ ] **Step 6: Implement lifecycle terminal rules**

Implement attention/unblock, completion, failure without permission, cancellation, abnormal worker exit cleanup, run terminal cleanup, and duplicate-event idempotency. Use event agent/worker ID first and `${role}:${taskId}` only as fallback.

- [ ] **Step 7: Run GREEN**

Run: `npx vitest run server/__tests__/piCrewLifecycle.test.ts server/__tests__/piCrew.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/src/providers/hook/pi-crew/piCrewLifecycle.ts server/src/providers/hook/pi-crew/feedTypes.ts server/src/providers/hook/pi-crew/piCrew.ts server/__tests__/piCrewLifecycle.test.ts server/__tests__/piCrew.test.ts
git commit -m "fix(pi-crew): 重构运行与任务生命周期"
```

### Task 3: UTF-8-Safe Incremental JSONL Reader

**Files:**

- Create: `server/src/providers/hook/pi-crew/jsonlReader.ts`
- Test: `server/__tests__/piCrewJsonlReader.test.ts`

**Interfaces:**

- Produces: `JsonlCheckpoint`, `ParsedJsonlRecord<T>`, and `IncrementalJsonlReader<T>` with `readAvailable(): ParsedJsonlRecord<T>[]`, `commit(endOffset: number): void`, `reset(): void`, `snapshot(): JsonlCheckpoint`.

- [ ] **Step 1: Write failing partial/large/UTF-8 tests**

Create real temporary files. Assert that an incomplete line produces no record, appending its remainder produces one record, a record over 64 KiB is intact, and Chinese plus emoji split at chunk boundaries parse exactly.

```ts
expect(reader.readAvailable()).toEqual([]);
append('界🙂"}\n');
expect(reader.readAvailable()[0].value.message).toBe(expectedMessage);
```

- [ ] **Step 2: Run RED**

Run: `npx vitest run server/__tests__/piCrewJsonlReader.test.ts`

Expected: FAIL because the reader does not exist.

- [ ] **Step 3: Implement complete-line decoding**

Use `StringDecoder('utf8')`, retain incomplete text, loop through all available chunks, record start/end byte offsets, and close descriptors in `finally`. Report malformed complete lines through an injected diagnostic callback and continue.

- [ ] **Step 4: Add failing truncation/rotation tests**

Test `truncateSync`, rename-and-recreate, temporary disappearance, and a replacement file larger than the previous offset. Assert each new valid event is emitted once after reset.

- [ ] **Step 5: Run RED for file identity**

Run: `npx vitest run server/__tests__/piCrewJsonlReader.test.ts`

Expected: FAIL on truncation or rotation recovery.

- [ ] **Step 6: Implement file identity recovery**

Track `dev`, `ino`, size, and a portable first-block fingerprint. Reset decoder/read offset when identity changes or size falls below committed offset. Missing files return no records without destroying the checkpoint.

- [ ] **Step 7: Run GREEN**

Run: `npx vitest run server/__tests__/piCrewJsonlReader.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/src/providers/hook/pi-crew/jsonlReader.ts server/__tests__/piCrewJsonlReader.test.ts
git commit -m "feat(pi-crew): 添加可靠 JSONL 增量读取"
```

### Task 4: Atomic Checkpoint Persistence and Startup Policy

**Files:**

- Create: `server/src/providers/hook/pi-crew/piCrewCheckpointStore.ts`
- Modify: `server/src/providers/hook/pi-crew/constants.ts`
- Test: `server/__tests__/piCrewCheckpointStore.test.ts`
- Test: `server/__tests__/piCrewFeedWatcher.test.ts`

**Interfaces:**

- Consumes: `JsonlCheckpoint` from Task 3.
- Produces: `PiCrewCheckpointStore` with `load(projectKey: string, runId: string): JsonlCheckpoint | null`, `save(projectKey: string, runId: string, checkpoint: JsonlCheckpoint): void`, `remove(projectKey: string, runId: string): void`.

- [ ] **Step 1: Write failing persistence tests**

Use an injected root directory. Verify round-trip, corrupt-file fallback with diagnostics, atomic replacement, and project/run key isolation.

- [ ] **Step 2: Run RED**

Run: `npx vitest run server/__tests__/piCrewCheckpointStore.test.ts`

Expected: FAIL because the store does not exist.

- [ ] **Step 3: Implement checkpoint store**

Write JSON to a sibling temporary file, `fsync`, then rename. Bound retained event IDs to 512 entries. Never write under `.crew`.

- [ ] **Step 4: Write failing startup-policy tests**

Create one active and one completed run with no checkpoint. Assert active history reconstructs from offset zero and completed history produces no hook payload. Add a stored checkpoint and assert only later records are read.

- [ ] **Step 5: Run RED for startup policy**

Run: `npx vitest run server/__tests__/piCrewFeedWatcher.test.ts`

Expected: FAIL because the watcher currently starts every run at zero.

- [ ] **Step 6: Implement complete terminal detection**

Scan complete JSONL records to find the last valid event without a 4 KiB assumption. Treat `run.completed`, `run.failed`, and `run.cancelled` as terminal. Select EOF, zero, or checkpoint offset according to the design.

- [ ] **Step 7: Run GREEN**

Run: `npx vitest run server/__tests__/piCrewCheckpointStore.test.ts server/__tests__/piCrewFeedWatcher.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/src/providers/hook/pi-crew/piCrewCheckpointStore.ts server/src/providers/hook/pi-crew/constants.ts server/src/providers/hook/pi-crew/piCrewFeedWatcher.ts server/__tests__/piCrewCheckpointStore.test.ts server/__tests__/piCrewFeedWatcher.test.ts
git commit -m "feat(pi-crew): 持久化读取检查点"
```

### Task 5: Ordered Retrying Hook Outbox

**Files:**

- Create: `server/src/providers/hook/pi-crew/hookOutbox.ts`
- Modify: `server/src/providers/hook/pi-crew/constants.ts`
- Modify: `server/src/providers/hook/pi-crew/piCrewFeedWatcher.ts`
- Test: `server/__tests__/piCrewHookOutbox.test.ts`

**Interfaces:**

- Produces: `HookOutbox`, `HookPayloadEnvelope`, `HookDeliveryResult`; `enqueue(item): Promise<void>`, `drain(timeoutMs: number): Promise<boolean>`, `dispose(): void`.

- [ ] **Step 1: Write failing strict-order tests**

Use a real local HTTP test server that delays the first response. Enqueue SessionStart and ToolStart and assert the server does not receive ToolStart before SessionStart completes.

- [ ] **Step 2: Run RED**

Run: `npx vitest run server/__tests__/piCrewHookOutbox.test.ts`

Expected: FAIL because the outbox does not exist.

- [ ] **Step 3: Implement per-outbox serialization**

Use one promise chain per run. Add `X-Pixel-Agents-Idempotency-Key`, explicit request timeout, response draining, and abort tracking.

- [ ] **Step 4: Write failing retry tests**

Assert network failure, 408, 429, and 500 retry in original order; 400 returns a permanent failure without an infinite retry; timeout aborts and retries. Inject deterministic backoff for tests.

- [ ] **Step 5: Run RED for retry policy**

Run: `npx vitest run server/__tests__/piCrewHookOutbox.test.ts`

Expected: FAIL on retry counts or timeout.

- [ ] **Step 6: Implement bounded retries and shutdown**

Use constants for request timeout, maximum attempts, base backoff, and drain timeout. `stop()` rejects new work, waits for queued work, and aborts sockets/timers on expiry.

- [ ] **Step 7: Connect watcher commit semantics**

Convert each parsed event to payload envelopes with `<eventId>:<index>`. Save the checkpoint only after the complete envelope succeeds or returns a diagnosed permanent failure.

- [ ] **Step 8: Run GREEN**

Run: `npx vitest run server/__tests__/piCrewHookOutbox.test.ts server/__tests__/piCrewFeedWatcher.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/src/providers/hook/pi-crew/hookOutbox.ts server/src/providers/hook/pi-crew/constants.ts server/src/providers/hook/pi-crew/piCrewFeedWatcher.ts server/__tests__/piCrewHookOutbox.test.ts server/__tests__/piCrewFeedWatcher.test.ts
git commit -m "feat(pi-crew): 保证 Hook 有序可靠投递"
```

### Task 6: Hook Ingress Idempotency

**Files:**

- Modify: `server/src/httpServer.ts`
- Modify: `server/src/constants.ts`
- Test: `server/__tests__/httpServerWs.test.ts`

**Interfaces:**

- Consumes: `X-Pixel-Agents-Idempotency-Key` from Task 5.
- Produces: bounded provider/key deduplication before `onHookEvent` dispatch.

- [ ] **Step 1: Write failing duplicate-ingress test**

POST the same provider, payload, and idempotency header twice; assert `onHookEvent` runs once and both responses are 2xx. POST the same key for another provider and assert it is independently accepted.

- [ ] **Step 2: Run RED**

Run: `npx vitest run server/__tests__/httpServerWs.test.ts`

Expected: FAIL because duplicate requests dispatch twice.

- [ ] **Step 3: Implement bounded TTL cache**

Key by `${providerId}:${idempotencyKey}`. Cap at 4096 entries and expire after 15 minutes. Requests without the header retain existing behavior.

- [ ] **Step 4: Run GREEN**

Run: `npx vitest run server/__tests__/httpServerWs.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/httpServer.ts server/src/constants.ts server/__tests__/httpServerWs.test.ts
git commit -m "fix(server): 去重重复 Hook 投递"
```

### Task 7: Provider Project Scopes and VS Code Multi-Root

**Files:**

- Modify: `core/src/provider.ts`
- Modify: `server/src/providers/hook/pi-crew/piCrew.ts`
- Modify: `server/src/providers/hook/pi-crew/piCrewFeedWatcher.ts`
- Modify: `server/src/cli.ts`
- Modify: `adapters/vscode/PixelAgentsViewProvider.ts`
- Test: `server/__tests__/piCrewFeedWatcher.test.ts`
- Test: `server/__tests__/cli.test.ts`
- Test: `server/__tests__/server.test.ts`

**Interfaces:**

- Consumes: `ProjectScope` from Task 1.
- Produces: optional `HookProvider.setProjectScopes(scopes: readonly ProjectScope[]): void` and watcher `replaceProjectScopes(scopes): Promise<void>`.

- [ ] **Step 1: Write failing watcher scope tests**

Assert two initial scopes are scanned, aliases are deduplicated, replacing scopes stops polling removed projects, and adding a scope discovers its run.

- [ ] **Step 2: Run RED**

Run: `npx vitest run server/__tests__/piCrewFeedWatcher.test.ts`

Expected: FAIL because watcher scopes are constructor-only.

- [ ] **Step 3: Implement scope replacement**

Replace `projectDirs` and unused `addProjectDir` with canonical `ProjectScope` storage. Drain and remove readers/outboxes for removed projects before dropping state.

- [ ] **Step 4: Write failing adapter composition tests**

Assert standalone supplies `process.cwd()` as one scope. Extract a pure VS Code scope-builder and assert all workspace folders are passed, with workspace names preserved as display names.

- [ ] **Step 5: Run RED for adapters**

Run: `npx vitest run server/__tests__/cli.test.ts server/__tests__/server.test.ts`

Expected: FAIL because scopes are not supplied.

- [ ] **Step 6: Wire standalone and VS Code**

Set scopes before installing pi-crew. Register `vscode.workspace.onDidChangeWorkspaceFolders` and replace scopes after additions/removals. Dispose the listener with the provider.

- [ ] **Step 7: Run GREEN and types**

Run: `npx vitest run server/__tests__/piCrewFeedWatcher.test.ts server/__tests__/cli.test.ts server/__tests__/server.test.ts && npm run check-types`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add core/src/provider.ts server/src/providers/hook/pi-crew/piCrew.ts server/src/providers/hook/pi-crew/piCrewFeedWatcher.ts server/src/cli.ts adapters/vscode/PixelAgentsViewProvider.ts server/__tests__/piCrewFeedWatcher.test.ts server/__tests__/cli.test.ts server/__tests__/server.test.ts
git commit -m "feat(pi-crew): 支持多项目动态监听"
```

### Task 8: Versioned Project-Area Mapping Migration

**Files:**

- Modify: `server/src/configPersistence.ts`
- Rewrite: `server/src/providers/hook/pi-agent/autoRoom.ts`
- Modify: `server/src/providers/hook/pi-crew/piCrewFeedWatcher.ts`
- Modify: `server/src/types.ts`
- Test: `server/__tests__/autoRoom.test.ts`
- Test: `server/__tests__/configPersistence.test.ts`

**Interfaces:**

- Consumes: `ProjectScope` from Task 1.
- Produces: `ProjectAreaConfigV2`, `migrateProjectAreas(scopes: readonly ProjectScope[]): ProjectAreaConfigV2`, `ensureProjectArea(scope: ProjectScope, namespace: 'standalone' | 'vscode'): { areaLabel: string; changed: boolean }`, `getProjectAreaLabels(scope: ProjectScope, namespace: 'standalone' | 'vscode'): string[]`.

- [ ] **Step 1: Replace basename-locking tests with failing v2 tests**

Assert `/a/frontend` and `/b/frontend` get distinct keys and labels, full-path legacy keys migrate directly, ambiguous basename mappings copy to both scopes with a warning, and migration is idempotent.

- [ ] **Step 2: Run RED**

Run: `npx vitest run server/__tests__/autoRoom.test.ts server/__tests__/configPersistence.test.ts`

Expected: FAIL because current migration collapses basename keys.

- [ ] **Step 3: Implement top-level v2 configuration**

Add a versioned shared `projectAreas` record keyed by project key. Read fallback order: project key, canonical path, workspace display name, basename. New writes update only v2. Keep legacy namespace records unchanged as migration input.

- [ ] **Step 4: Implement deterministic Area label collision handling**

Reuse an existing unambiguous Area label for the first bound project. For another project with the same display name, create `${displayName} · ${project.key.slice(-6)}` without moving existing Area tiles.

- [ ] **Step 5: Update watcher lookup**

Resolve all mapped labels once per project and cache them until configuration changes. Use the first label only for the compatibility `preferred_area` payload; preserve the full label list in project state for normal seating.

- [ ] **Step 6: Run GREEN**

Run: `npx vitest run server/__tests__/autoRoom.test.ts server/__tests__/configPersistence.test.ts server/__tests__/piCrewFeedWatcher.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/configPersistence.ts server/src/providers/hook/pi-agent/autoRoom.ts server/src/providers/hook/pi-crew/piCrewFeedWatcher.ts server/src/types.ts server/__tests__/autoRoom.test.ts server/__tests__/configPersistence.test.ts
git commit -m "feat(area): 迁移稳定项目区域映射"
```

### Task 9: Canonical Shared Seat Derivation

**Files:**

- Create: `core/src/layout/seatTiles.ts`
- Modify: `core/src/index.ts`
- Modify: `webview-ui/src/office/layout/layoutSerializer.ts`
- Modify: `server/src/providers/hook/pi-agent/autoRoom.ts`
- Test: `server/__tests__/seatTiles.test.ts`
- Test: `server/__tests__/autoRoom.test.ts`
- Test: `webview-ui/test/layoutSerializer.test.ts`

**Interfaces:**

- Produces: `deriveSeatTiles(furniture, catalog): Array<{ col: number; row: number; furnitureId: string }>`.

- [ ] **Step 1: Write failing shared-seat tests**

Cover a normal chair, rotated chair, two-tile couch, catalog background seat tiles, and non-seat furniture. Assert unknown furniture creates no seats.

- [ ] **Step 2: Run RED**

Run: `npx vitest run server/__tests__/seatTiles.test.ts`

Expected: FAIL because the shared helper does not exist.

- [ ] **Step 3: Extract UI-independent seat derivation**

Move catalog category/footprint/background-tile seat discovery into core. Keep facing direction, desk association, and UI `Seat` construction in `layoutSerializer.ts`.

- [ ] **Step 4: Write failing auto-room allocation tests**

Assert auto-room assigns at most four canonical seat tiles, never overwrites existing Area tiles, handles resized `areaTiles`, and does not assign non-seat furniture.

- [ ] **Step 5: Run RED for auto-room**

Run: `npx vitest run server/__tests__/autoRoom.test.ts`

Expected: FAIL because auto-room still uses type prefixes.

- [ ] **Step 6: Replace prefix heuristic and run GREEN**

Run: `npx vitest run server/__tests__/seatTiles.test.ts server/__tests__/autoRoom.test.ts && npm run test:webview -- layoutSerializer.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add core/src/layout/seatTiles.ts core/src/index.ts webview-ui/src/office/layout/layoutSerializer.ts server/src/providers/hook/pi-agent/autoRoom.ts server/__tests__/seatTiles.test.ts server/__tests__/autoRoom.test.ts webview-ui/test/layoutSerializer.test.ts
git commit -m "refactor(area): 统一座位推导规则"
```

### Task 10: End-to-End Watcher Integration and Diagnostics

**Files:**

- Modify: `server/src/providers/hook/pi-crew/piCrewFeedWatcher.ts`
- Modify: `server/src/providers/hook/pi-crew/consentCopy.ts`
- Modify: `server/src/agentDiagnostics.ts`
- Test: `server/__tests__/piCrewIntegration.test.ts`
- Test: `server/__tests__/agentDiagnostics.test.ts`
- Modify: `e2e/tests/standalone/hooks.spec.ts`
- Modify: `e2e/helpers/hooks.ts`

**Interfaces:**

- Consumes all preceding tasks.
- Produces observable, rate-limited reader/delivery/migration diagnostics and a complete JSONL-to-store path.

- [ ] **Step 1: Write failing server integration test**

Start a real Pixel Agents HTTP server, watcher, and temporary `.crew` run. Append `run.created`, `task.started`, attention, progress, completion, and run completion. Assert ordered final store state and no orphan agents.

- [ ] **Step 2: Run RED**

Run: `npx vitest run server/__tests__/piCrewIntegration.test.ts`

Expected: FAIL until watcher composition and lifecycle integration are complete.

- [ ] **Step 3: Complete watcher composition**

Ensure each scope/run owns reader, lifecycle, checkpoint, and outbox. Replace empty catches with rate-limited diagnostics containing project key, run ID, file, offset, and event ID.

- [ ] **Step 4: Add failing diagnostic tests**

Assert malformed JSON, persistent read failure, permanent HTTP failure, ambiguous migration, and corrupt checkpoint are visible without exposing the bearer token.

- [ ] **Step 5: Run RED and implement diagnostic aggregation**

Run: `npx vitest run server/__tests__/agentDiagnostics.test.ts server/__tests__/piCrewIntegration.test.ts`

Expected before implementation: FAIL on missing diagnostic records. Add bounded recent pi-crew diagnostics to `buildAgentDiagnostics` and rerun to PASS.

- [ ] **Step 6: Add standalone E2E scenario**

Drive a temporary `.crew` log and assert a worker appears, becomes blocked, resumes, and disappears. Restart standalone and assert the completed run does not replay.

- [ ] **Step 7: Run targeted E2E**

Run: `npm run build && npm run e2e -- --grep "pi-crew"`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/src/providers/hook/pi-crew/piCrewFeedWatcher.ts server/src/providers/hook/pi-crew/consentCopy.ts server/src/agentDiagnostics.ts server/__tests__/piCrewIntegration.test.ts server/__tests__/agentDiagnostics.test.ts e2e/tests/standalone/hooks.spec.ts e2e/helpers/hooks.ts
git commit -m "test(pi-crew): 覆盖完整事件与恢复链路"
```

### Task 11: Full Regression Verification

**Files:**

- Modify only files required by failures attributable to Tasks 1-10.

**Interfaces:**

- Consumes the complete implementation.
- Produces verification evidence; no new feature behavior.

- [ ] **Step 1: Inspect scope and formatting**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; unrelated pre-existing changes remain identifiable and unstaged.

- [ ] **Step 2: Run generated protocol and type gates**

Run: `npm run asyncapi:generate && npm run asyncapi:validate && npm run check-types`

Expected: exit 0 and no unexpected generated drift.

- [ ] **Step 3: Run lint and formatting gates**

Run: `npm run lint && npm run format:check`

Expected: exit 0.

- [ ] **Step 4: Run all unit and package tests**

Run: `npm test && npm run test:package-contract`

Expected: all suites pass with zero failures.

- [ ] **Step 5: Run production packaging verification**

Run: `npm run build && npm run verify:npm-package`

Expected: production build and installed-tarball verification exit 0.

- [ ] **Step 6: Run relevant E2E suite**

Run: `npm run e2e -- --grep "pi-crew|areas|multi-root|hooks"`

Expected: all selected Playwright scenarios pass.

- [ ] **Step 7: Review acceptance criteria**

Map every acceptance criterion in `docs/superpowers/specs/2026-08-22-pi-crew-reliability-design.md` to a passing test or verification output. Record any environmental skip explicitly rather than claiming it passed.

- [ ] **Step 8: Record final repository state**

Run: `git status --short && git log -12 --oneline`

Expected: implementation commits are visible; any unrelated pre-existing working-tree changes remain uncommitted and identifiable.
