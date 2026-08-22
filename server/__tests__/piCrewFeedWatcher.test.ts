import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProjectScope } from '../../core/src/projectScope.js';
import type {
  HookDeliveryResult,
  HookOutboxItem,
} from '../src/providers/hook/pi-crew/hookOutbox.js';
import { IncrementalJsonlReader } from '../src/providers/hook/pi-crew/jsonlReader.js';
import { piCrewProvider } from '../src/providers/hook/pi-crew/piCrew.js';
import { PiCrewCheckpointStore } from '../src/providers/hook/pi-crew/piCrewCheckpointStore.js';
import { PiCrewEventWatcher } from '../src/providers/hook/pi-crew/piCrewFeedWatcher.js';

describe('PiCrewEventWatcher', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-crew-watcher-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('fires onNewProject when a new project directory is discovered', () => {
    const newProjects: string[] = [];
    const watcher = new PiCrewEventWatcher({
      projectScopes: [createProjectScope(tempDir)],
      serverUrl: 'http://127.0.0.1:1234',
      authToken: 'test-token',
      onNewProject: (projectDir) => {
        newProjects.push(projectDir);
      },
    });

    // Create the .crew/state/runs/ directory so scanRunsDir finds the project
    const runsDir = path.join(tempDir, '.crew', 'state', 'runs');
    fs.mkdirSync(runsDir, { recursive: true });

    // Start the watcher (it will poll and discover the project)
    watcher.start();

    expect(newProjects).toContain(createProjectScope(tempDir).path);

    watcher.stop();
  });

  it('does not fire onNewProject for already-known project directories', () => {
    const newProjects: string[] = [];
    const watcher = new PiCrewEventWatcher({
      projectScopes: [createProjectScope(tempDir)],
      serverUrl: 'http://127.0.0.1:1234',
      authToken: 'test-token',
      onNewProject: (projectDir) => {
        newProjects.push(projectDir);
      },
    });

    const runsDir = path.join(tempDir, '.crew', 'state', 'runs');
    fs.mkdirSync(runsDir, { recursive: true });

    // First poll: triggers onNewProject
    watcher.start();
    expect(newProjects).toContain(createProjectScope(tempDir).path);

    // Second poll: should NOT trigger onNewProject again
    const beforeCount = newProjects.length;
    watcher.start(); // re-start triggers another poll
    expect(newProjects.length).toBe(beforeCount);

    watcher.stop();
  });

  it('handles missing .crew/state/runs/ directory gracefully', () => {
    const newProjects: string[] = [];
    const watcher = new PiCrewEventWatcher({
      projectScopes: [createProjectScope(tempDir)], // tempDir has no .crew/ subdirectory
      serverUrl: 'http://127.0.0.1:1234',
      authToken: 'test-token',
      onNewProject: (projectDir) => {
        newProjects.push(projectDir);
      },
    });

    // Should not throw and should not call onNewProject
    watcher.start();
    expect(newProjects).toHaveLength(0);
    watcher.stop();
  });

  it('deduplicates aliased scopes while keeping same-basename roots independent', async () => {
    const first = path.join(tempDir, 'one', 'frontend');
    const second = path.join(tempDir, 'two', 'frontend');
    writeRun(first, 'first-run', [
      { time: '2026-08-22T00:00:00.000Z', type: 'run.created', runId: 'first-run' },
    ]);
    writeRun(second, 'second-run', [
      { time: '2026-08-22T00:00:00.000Z', type: 'run.created', runId: 'second-run' },
    ]);

    const captured: Record<string, unknown>[] = [];
    const discovered: string[] = [];
    const watcher = new PiCrewEventWatcher({
      projectScopes: [
        createProjectScope(first, 'First frontend'),
        createProjectScope(path.join(first, '..', 'frontend'), 'Aliased frontend'),
        createProjectScope(second, 'Second frontend'),
      ],
      serverUrl: 'http://127.0.0.1:1234',
      authToken: 'test-token',
      onNewProject: (projectDir) => discovered.push(projectDir),
      outboxFactory: () => createCapturingOutbox(captured, () => true),
      checkpointStore: new PiCrewCheckpointStore({
        rootDir: path.join(tempDir, 'pixel-agents-state'),
      }),
    });

    watcher.start();
    await watcher.waitForIdle();

    expect(discovered).toEqual([createProjectScope(first).path, createProjectScope(second).path]);
    expect(
      captured.filter((payload) => payload.hook_event_name === 'CrewSessionStart'),
    ).toHaveLength(2);
    expect(
      new Set(
        captured
          .filter((payload) => payload.hook_event_name === 'CrewSessionStart')
          .map((payload) => payload.session_id),
      ),
    ).toHaveLength(2);

    await watcher.stop();
  });

  it('replaces scopes by draining removed runs and scanning added roots', async () => {
    const removed = path.join(tempDir, 'removed');
    const added = path.join(tempDir, 'added');
    const { eventsPath: removedEventsPath } = writeRun(removed, 'removed-run', [
      { time: '2026-08-22T00:00:00.000Z', type: 'run.created', runId: 'removed-run' },
    ]);
    writeRun(added, 'added-run', [
      { time: '2026-08-22T00:00:00.000Z', type: 'run.created', runId: 'added-run' },
    ]);

    const captured: Record<string, unknown>[] = [];
    let drains = 0;
    let disposals = 0;
    const watcher = new PiCrewEventWatcher({
      projectScopes: [createProjectScope(removed)],
      serverUrl: 'http://127.0.0.1:1234',
      authToken: 'test-token',
      checkpointStore: new PiCrewCheckpointStore({
        rootDir: path.join(tempDir, 'pixel-agents-state'),
      }),
      outboxFactory: () => ({
        ...createCapturingOutbox(captured, () => true),
        drain: async () => {
          drains += 1;
          return true;
        },
        dispose: () => {
          disposals += 1;
        },
      }),
    });

    watcher.start();
    await watcher.waitForIdle();
    const initialPayloadCount = captured.length;

    await watcher.replaceProjectScopes([createProjectScope(added)]);
    await watcher.waitForIdle();

    fs.appendFileSync(
      removedEventsPath,
      `${JSON.stringify({
        time: '2026-08-22T00:00:01.000Z',
        type: 'task.started',
        runId: 'removed-run',
        taskId: 'ignored-task',
      })}\n`,
    );
    (watcher as unknown as { poll: () => void }).poll();
    await watcher.waitForIdle();

    expect(drains).toBe(1);
    expect(disposals).toBe(1);
    expect(captured).toHaveLength(initialPayloadCount + 2);
    expect(captured.map((payload) => payload.session_id).some((id) => id === undefined)).toBe(
      false,
    );
    expect(
      (watcher as unknown as { runStates: Map<string, unknown> }).runStates.has(removedEventsPath),
    ).toBe(false);

    await watcher.stop();
  });

  it('tracks discovered runs via scanRunsDir', () => {
    const watcher = new PiCrewEventWatcher({
      projectScopes: [createProjectScope(tempDir)],
      serverUrl: 'http://127.0.0.1:1234',
      authToken: 'test-token',
    });

    // Create a run directory with events.jsonl
    const runDir = path.join(tempDir, '.crew', 'state', 'runs', 'run-001');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'events.jsonl'), '');

    watcher.start();
    expect(watcher.isRunning()).toBe(true);
    watcher.stop();
  });

  it('prunes a stale cancelled run', async () => {
    const watcher = new PiCrewEventWatcher({
      projectScopes: [createProjectScope(tempDir)],
      serverUrl: 'http://127.0.0.1:1234',
      authToken: 'test-token',
      checkpointStore: new PiCrewCheckpointStore({
        rootDir: path.join(tempDir, 'pixel-agents-state'),
      }),
    });
    const runDir = path.join(tempDir, '.crew', 'state', 'runs', 'run-001');
    fs.mkdirSync(runDir, { recursive: true });
    const eventsPath = path.join(runDir, 'events.jsonl');
    fs.writeFileSync(
      eventsPath,
      `${JSON.stringify({
        time: '2026-08-22T00:00:00.000Z',
        type: 'run.cancelled',
        runId: 'run-001',
      })}\n`,
    );
    const stale = new Date(Date.now() - 6 * 60 * 1000);
    fs.utimesSync(eventsPath, stale, stale);

    watcher.start();
    await watcher.waitForIdle();

    const states = (watcher as unknown as { runStates: Map<string, unknown> }).runStates;
    expect(states).toHaveLength(0);
    await watcher.stop();
  });

  it('forwards a run mismatch diagnostic to hook normalization', () => {
    const captured: Record<string, unknown>[] = [];
    const watcher = new PiCrewEventWatcher({
      projectScopes: [createProjectScope(tempDir)],
      serverUrl: 'http://127.0.0.1:1234',
      authToken: 'test-token',
      outboxFactory: () => createCapturingOutbox(captured, () => true),
    });
    const runDir = path.join(tempDir, '.crew', 'state', 'runs', 'run-001');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'events.jsonl'),
      `${JSON.stringify({
        time: '2026-08-22T00:00:00.000Z',
        type: 'task.started',
        runId: 'other-run',
        taskId: 't1',
      })}\n`,
    );

    watcher.start();

    expect(captured[0].hook_event_name).toBe('CrewDiagnostic');
    expect(piCrewProvider.normalizeHookEvent(captured[0])?.event.kind).toBe('diagnostic');
    watcher.stop();
  });

  it('reconstructs active history from zero when the run has no checkpoint', () => {
    const captured: Record<string, unknown>[] = [];
    const { eventsPath } = writeRun(tempDir, 'active-run', [
      { time: '2026-08-22T00:00:00.000Z', type: 'run.created', runId: 'active-run' },
    ]);
    const store = new PiCrewCheckpointStore({ rootDir: path.join(tempDir, 'pixel-agents-state') });
    const watcher = createCapturingWatcher(tempDir, captured, store);

    watcher.start();

    expect(captured.map((payload) => payload.hook_event_name)).toEqual([
      'CrewSessionStart',
      'CrewPlanStart',
    ]);
    expect(
      store.load(createProjectScope(tempDir).key, 'active-run')?.committedOffset,
    ).toBeUndefined();
    expect(fs.existsSync(eventsPath)).toBe(true);
    watcher.stop();
  });

  it('starts a terminal history at EOF even when its final complete record exceeds 4 KiB', () => {
    const captured: Record<string, unknown>[] = [];
    writeRun(tempDir, 'completed-run', [
      { time: '2026-08-22T00:00:00.000Z', type: 'run.created', runId: 'completed-run' },
      {
        time: '2026-08-22T00:00:01.000Z',
        type: 'run.completed',
        runId: 'completed-run',
        message: 'x'.repeat(5 * 1024),
      },
    ]);
    const store = new PiCrewCheckpointStore({ rootDir: path.join(tempDir, 'pixel-agents-state') });
    const watcher = createCapturingWatcher(tempDir, captured, store);

    watcher.start();

    expect(captured).toEqual([]);
    expect(
      store.load(createProjectScope(tempDir).key, 'completed-run')?.committedOffset,
    ).toBeGreaterThan(5 * 1024);
    watcher.stop();
  });

  it('retries a terminal startup checkpoint save without replaying its history', async () => {
    const { eventsPath } = writeRun(tempDir, 'terminal-save-retry', [
      { time: '2026-08-22T00:00:00.000Z', type: 'run.created', runId: 'terminal-save-retry' },
      { time: '2026-08-22T00:00:01.000Z', type: 'run.completed', runId: 'terminal-save-retry' },
    ]);
    const store = new PiCrewCheckpointStore({ rootDir: path.join(tempDir, 'pixel-agents-state') });
    const originalSave = store.save.bind(store);
    let failSave = true;
    (store as unknown as { save: typeof store.save }).save = (...args) => {
      if (failSave) throw new Error('terminal checkpoint disk full');
      originalSave(...args);
    };
    const diagnostics: string[] = [];
    const captured: Record<string, unknown>[] = [];
    const watcher = new PiCrewEventWatcher({
      projectScopes: [createProjectScope(tempDir)],
      serverUrl: 'http://127.0.0.1:1234',
      authToken: 'test-token',
      checkpointStore: store,
      onDiagnostic: (message) => diagnostics.push(message),
      outboxFactory: () => createCapturingOutbox(captured, () => true),
    });

    expect(() => watcher.start()).not.toThrow();
    expect(captured).toEqual([]);
    expect(store.load(createProjectScope(tempDir).key, 'terminal-save-retry')).toBeNull();
    expect(diagnostics.join('\n')).toContain('terminal checkpoint disk full');

    failSave = false;
    await watcher.waitForIdle();
    (watcher as unknown as { poll: () => void }).poll();

    expect(
      await waitUntil(
        () =>
          store.load(createProjectScope(tempDir).key, 'terminal-save-retry')?.committedOffset ===
          fs.statSync(eventsPath).size,
      ),
    ).toBe(true);
    expect(captured).toEqual([]);
    await watcher.stop();
  });

  it('resumes only records after a stored checkpoint', () => {
    const captured: Record<string, unknown>[] = [];
    const { eventsPath } = writeRun(tempDir, 'resumed-run', [
      { time: '2026-08-22T00:00:00.000Z', type: 'run.created', runId: 'resumed-run' },
      {
        time: '2026-08-22T00:00:01.000Z',
        type: 'task.started',
        runId: 'resumed-run',
        taskId: 'later-task',
      },
    ]);
    const reader = new IncrementalJsonlReader(eventsPath);
    const firstRecord = reader.readAvailable()[0]!;
    reader.commit(firstRecord.endOffset);
    const store = new PiCrewCheckpointStore({ rootDir: path.join(tempDir, 'pixel-agents-state') });
    store.save(createProjectScope(tempDir).key, 'resumed-run', reader.snapshot());
    const watcher = createCapturingWatcher(tempDir, captured, store);

    watcher.start();

    expect(captured.map((payload) => payload.hook_event_name)).toEqual([
      'CrewSessionStart',
      'CrewTaskStart',
    ]);
    watcher.stop();
  });

  it('persists an offset only after a delivery confirmation and then suppresses replay', async () => {
    const { eventsPath } = writeRun(tempDir, 'confirmed-run', [
      { time: '2026-08-22T00:00:00.000Z', type: 'run.created', runId: 'confirmed-run' },
    ]);
    const store = new PiCrewCheckpointStore({ rootDir: path.join(tempDir, 'pixel-agents-state') });
    const unconfirmed = createCapturingWatcher(tempDir, [], store, () => false);

    unconfirmed.start();

    await unconfirmed.waitForIdle();
    (unconfirmed as unknown as { poll: () => void }).poll();

    expect(store.load(createProjectScope(tempDir).key, 'confirmed-run')).toBeNull();
    await unconfirmed.stop();

    const confirmedPayloads: Record<string, unknown>[] = [];
    const confirmed = createCapturingWatcher(tempDir, confirmedPayloads, store, () => true);
    confirmed.start();

    expect(confirmedPayloads).toHaveLength(2);
    expect(
      await waitUntil(
        () =>
          store.load(createProjectScope(tempDir).key, 'confirmed-run')?.committedOffset ===
          fs.statSync(eventsPath).size,
      ),
    ).toBe(true);
    await confirmed.stop();

    const replayedPayloads: Record<string, unknown>[] = [];
    const restarted = createCapturingWatcher(tempDir, replayedPayloads, store, () => true);
    restarted.start();

    expect(replayedPayloads).toEqual([]);
    await restarted.stop();
  });

  it('commits a source event only after its complete envelope is permanently diagnosed', async () => {
    const { eventsPath } = writeRun(tempDir, 'permanent-outbox-run', [
      { time: '2026-08-22T00:00:00.000Z', type: 'run.created', runId: 'permanent-outbox-run' },
    ]);
    const store = new PiCrewCheckpointStore({ rootDir: path.join(tempDir, 'pixel-agents-state') });
    const delivery = deferred<HookDeliveryResult>();
    const delivered: HookOutboxItem[] = [];
    const watcher = new PiCrewEventWatcher({
      projectScopes: [createProjectScope(tempDir)],
      serverUrl: 'http://127.0.0.1:1234',
      authToken: 'test-token',
      checkpointStore: store,
      outboxFactory: () => ({
        enqueue: (item: HookOutboxItem) => {
          delivered.push(item);
          return delivery.promise;
        },
        drain: async () => true,
      }),
    });

    watcher.start();

    expect(await waitUntil(() => delivered.length === 1)).toBe(true);
    expect(store.load(createProjectScope(tempDir).key, 'permanent-outbox-run')).toBeNull();
    expect(delivered[0]?.payloads.map((payload) => payload.idempotencyKey)).toEqual([
      expect.stringMatching(/:0$/),
      expect.stringMatching(/:1$/),
    ]);

    delivery.resolve({ outcome: 'permanent_failure', attempts: 1, permanentFailures: 1 });

    expect(
      await waitUntil(
        () =>
          store.load(createProjectScope(tempDir).key, 'permanent-outbox-run')?.committedOffset ===
          fs.statSync(eventsPath).size,
      ),
    ).toBe(true);
    await watcher.stop();
  });

  it('reaches an enqueue safe point before stopping and draining run outboxes', async () => {
    writeRun(tempDir, 'stop-safe-point', [
      { time: '2026-08-22T00:00:00.000Z', type: 'run.created', runId: 'stop-safe-point' },
    ]);
    const enteredBeforeEnqueue = deferred<void>();
    const releaseEnqueue = deferred<void>();
    let drainCalls = 0;
    const watcher = new PiCrewEventWatcher({
      projectScopes: [createProjectScope(tempDir)],
      serverUrl: 'http://127.0.0.1:1234',
      authToken: 'test-token',
      checkpointStore: new PiCrewCheckpointStore({
        rootDir: path.join(tempDir, 'pixel-agents-state'),
      }),
      beforeOutboxEnqueue: async () => {
        enteredBeforeEnqueue.resolve();
        await releaseEnqueue.promise;
      },
      outboxFactory: () => ({
        enqueue: async () => ({ outcome: 'success', attempts: 1, permanentFailures: 0 }),
        drain: async () => {
          drainCalls += 1;
          return true;
        },
      }),
    });

    try {
      watcher.start();
      expect(await waitUntil(() => enteredBeforeEnqueue.settled)).toBe(true);

      const stopping = watcher.stop();
      await nextTick();
      expect(drainCalls).toBe(0);

      releaseEnqueue.resolve();
      await stopping;
      expect(drainCalls).toBe(1);
    } finally {
      releaseEnqueue.resolve();
      await watcher.stop();
    }
  });

  it('retains a processing terminal run so stop can drain its outbox', async () => {
    const { eventsPath } = writeRun(tempDir, 'prune-processing-run', [
      { time: '2026-08-22T00:00:00.000Z', type: 'run.created', runId: 'prune-processing-run' },
    ]);
    const terminalEnqueued = deferred<void>();
    const terminalDelivery = deferred<HookDeliveryResult>();
    let enqueueCalls = 0;
    let drainCalls = 0;
    const watcher = new PiCrewEventWatcher({
      projectScopes: [createProjectScope(tempDir)],
      serverUrl: 'http://127.0.0.1:1234',
      authToken: 'test-token',
      checkpointStore: new PiCrewCheckpointStore({
        rootDir: path.join(tempDir, 'pixel-agents-state'),
      }),
      outboxFactory: () => ({
        enqueue: (item: HookOutboxItem) => {
          enqueueCalls += 1;
          if (enqueueCalls === 1) {
            return Promise.resolve({
              outcome: 'success' as const,
              attempts: item.payloads.length,
              permanentFailures: 0,
            });
          }
          terminalEnqueued.resolve();
          return terminalDelivery.promise;
        },
        drain: async () => {
          drainCalls += 1;
          terminalDelivery.resolve({
            outcome: 'retryable_failure',
            attempts: 1,
            permanentFailures: 0,
          });
          return false;
        },
      }),
    });

    watcher.start();
    await watcher.waitForIdle();
    fs.appendFileSync(
      eventsPath,
      `${JSON.stringify({
        time: '2026-08-22T00:00:01.000Z',
        type: 'run.completed',
        runId: 'prune-processing-run',
      })}\n`,
    );
    const stale = new Date(Date.now() - 6 * 60 * 1000);
    fs.utimesSync(eventsPath, stale, stale);

    try {
      (watcher as unknown as { poll: () => void }).poll();
      await terminalEnqueued.promise;

      const states = (watcher as unknown as { runStates: Map<string, unknown> }).runStates;
      const canonicalEventsPath = path.join(
        createProjectScope(tempDir).path,
        '.crew',
        'state',
        'runs',
        'prune-processing-run',
        'events.jsonl',
      );
      expect(states.has(canonicalEventsPath)).toBe(true);

      await watcher.stop();
      expect(drainCalls).toBe(1);
    } finally {
      terminalDelivery.resolve({ outcome: 'retryable_failure', attempts: 1, permanentFailures: 0 });
      await watcher.stop();
    }
  });

  it('does not cross an unconfirmed record to commit a later confirmed record', () => {
    writeRun(tempDir, 'ordered-confirmation', [
      { time: '2026-08-22T00:00:00.000Z', type: 'run.created', runId: 'ordered-confirmation' },
      {
        time: '2026-08-22T00:00:01.000Z',
        type: 'task.started',
        runId: 'ordered-confirmation',
        taskId: 't1',
      },
    ]);
    const store = new PiCrewCheckpointStore({ rootDir: path.join(tempDir, 'pixel-agents-state') });
    const watcher = createCapturingWatcher(tempDir, [], store, ...[false, true]);

    watcher.start();

    expect(store.load(createProjectScope(tempDir).key, 'ordered-confirmation')).toBeNull();
    watcher.stop();
  });

  it('re-emits the original payload from the same watcher after a failed confirmation', async () => {
    writeRun(tempDir, 'retry-same-watcher', [
      { time: '2026-08-22T00:00:00.000Z', type: 'run.created', runId: 'retry-same-watcher' },
    ]);
    const store = new PiCrewCheckpointStore({ rootDir: path.join(tempDir, 'pixel-agents-state') });
    let confirmed = false;
    const captured: Record<string, unknown>[] = [];
    const watcher = createCapturingWatcher(tempDir, captured, store, () => confirmed);

    watcher.start();
    await watcher.waitForIdle();
    confirmed = true;
    (watcher as unknown as { poll: () => void }).poll();

    await watcher.waitForIdle();
    expect(captured).toHaveLength(4);
    expect(captured.map((payload) => payload.hook_event_name)).toEqual([
      'CrewSessionStart',
      'CrewPlanStart',
      'CrewSessionStart',
      'CrewPlanStart',
    ]);
    expect(
      store.load(createProjectScope(tempDir).key, 'retry-same-watcher')?.committedOffset,
    ).toBeGreaterThan(0);
    await watcher.stop();
  });

  it('rebuilds lifecycle when rotation replaces a terminal run with a new active history', async () => {
    const { eventsPath } = writeRun(tempDir, 'rotated-run', [
      {
        time: '2026-08-22T00:00:00.000Z',
        type: 'run.created',
        runId: 'rotated-run',
        metadata: { fingerprint: 'old-created' },
      },
    ]);
    const store = new PiCrewCheckpointStore({ rootDir: path.join(tempDir, 'pixel-agents-state') });
    const captured: Record<string, unknown>[] = [];
    const watcher = createCapturingWatcher(tempDir, captured, store, () => true);
    watcher.start();
    expect(await waitUntil(() => captured.length === 2)).toBe(true);
    await watcher.waitForIdle();
    fs.appendFileSync(
      eventsPath,
      `${JSON.stringify({ time: '2026-08-22T00:00:01.000Z', type: 'run.completed', runId: 'rotated-run', metadata: { fingerprint: 'old-completed' } })}\n`,
    );
    (watcher as unknown as { poll: () => void }).poll();
    expect(await waitUntil(() => captured.length === 4)).toBe(true);
    await watcher.waitForIdle();
    fs.renameSync(eventsPath, `${eventsPath}.old`);
    fs.writeFileSync(
      eventsPath,
      `${JSON.stringify({ time: '2026-08-22T00:00:02.000Z', type: 'run.created', runId: 'rotated-run', metadata: { fingerprint: 'replacement-created' } })}\n`,
    );

    (watcher as unknown as { poll: () => void }).poll();

    expect(await waitUntil(() => captured.length === 6)).toBe(true);
    expect(captured.slice(-2).map((payload) => payload.hook_event_name)).toEqual([
      'CrewSessionStart',
      'CrewPlanStart',
    ]);
    await watcher.stop();
  });

  it('stores confirmed source event IDs and suppresses them after rotation', async () => {
    const { eventsPath } = writeRun(tempDir, 'dedupe-run', [
      {
        time: '2026-08-22T00:00:00.000Z',
        type: 'run.created',
        runId: 'dedupe-run',
        metadata: { fingerprint: 'same-source' },
      },
    ]);
    const store = new PiCrewCheckpointStore({ rootDir: path.join(tempDir, 'pixel-agents-state') });
    const captured: Record<string, unknown>[] = [];
    const watcher = createCapturingWatcher(tempDir, captured, store, () => true);
    watcher.start();
    expect(await waitUntil(() => captured.length === 2)).toBe(true);
    await watcher.waitForIdle();
    fs.renameSync(eventsPath, `${eventsPath}.old`);
    fs.writeFileSync(
      eventsPath,
      `${JSON.stringify({ time: '2026-08-22T00:00:00.000Z', type: 'run.created', runId: 'dedupe-run', metadata: { fingerprint: 'same-source' } })}\n`,
    );

    (watcher as unknown as { poll: () => void }).poll();

    expect(
      await waitUntil(
        () =>
          store.load(createProjectScope(tempDir).key, 'dedupe-run')?.recentEventIds.length === 1,
      ),
    ).toBe(true);
    expect(store.load(createProjectScope(tempDir).key, 'dedupe-run')?.recentEventIds).toEqual([
      'fingerprint:same-source',
    ]);
    expect(captured).toHaveLength(2);
    await watcher.stop();
  });

  it('rolls back reader and lifecycle when checkpoint save fails, then replays with a diagnostic', async () => {
    const { eventsPath } = writeRun(tempDir, 'save-failure-run', [
      { time: '2026-08-22T00:00:00.000Z', type: 'run.created', runId: 'save-failure-run' },
    ]);
    const store = new PiCrewCheckpointStore({ rootDir: path.join(tempDir, 'pixel-agents-state') });
    const originalSave = store.save.bind(store);
    let failSave = true;
    (store as unknown as { save: typeof store.save }).save = (...args) => {
      if (failSave) throw new Error('checkpoint disk full');
      originalSave(...args);
    };
    const diagnostics: string[] = [];
    const captured: Record<string, unknown>[] = [];
    const watcher = new PiCrewEventWatcher({
      projectScopes: [createProjectScope(tempDir)],
      serverUrl: 'http://127.0.0.1:1234',
      authToken: 'test-token',
      checkpointStore: store,
      onDiagnostic: (message) => diagnostics.push(message),
      outboxFactory: () => createCapturingOutbox(captured, () => true),
    });

    watcher.start();
    await watcher.waitForIdle();
    failSave = false;
    (watcher as unknown as { poll: () => void }).poll();

    expect(await waitUntil(() => captured.length === 4)).toBe(true);
    expect(captured.map((payload) => payload.hook_event_name)).toEqual([
      'CrewSessionStart',
      'CrewPlanStart',
      'CrewSessionStart',
      'CrewPlanStart',
    ]);
    expect(store.load(createProjectScope(tempDir).key, 'save-failure-run')?.committedOffset).toBe(
      fs.statSync(eventsPath).size,
    );
    expect(diagnostics.join('\n')).toContain('checkpoint disk full');
    await watcher.stop();
  });

  it('silently reapplies a rotated planner before a new terminal event', async () => {
    const { eventsPath } = writeRun(tempDir, 'silent-rotation', [
      {
        time: '2026-08-22T00:00:00.000Z',
        type: 'run.created',
        runId: 'silent-rotation',
        metadata: { fingerprint: 'planner-event' },
      },
    ]);
    const store = new PiCrewCheckpointStore({ rootDir: path.join(tempDir, 'pixel-agents-state') });
    const captured: Record<string, unknown>[] = [];
    const watcher = createCapturingWatcher(tempDir, captured, store, () => true);
    watcher.start();
    expect(await waitUntil(() => captured.length === 2)).toBe(true);
    await watcher.waitForIdle();
    fs.renameSync(eventsPath, `${eventsPath}.old`);
    fs.writeFileSync(
      eventsPath,
      `${[
        {
          time: '2026-08-22T00:00:00.000Z',
          type: 'run.created',
          runId: 'silent-rotation',
          metadata: { fingerprint: 'planner-event' },
        },
        {
          time: '2026-08-22T00:00:01.000Z',
          type: 'run.completed',
          runId: 'silent-rotation',
          metadata: { fingerprint: 'new-terminal' },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n')}\n`,
    );

    (watcher as unknown as { poll: () => void }).poll();

    await watcher.waitForIdle();
    expect(captured).toHaveLength(4);
    expect(captured.slice(-2).map((payload) => payload.hook_event_name)).toEqual([
      'CrewPlanDone',
      'CrewSessionEnd',
    ]);
    await watcher.stop();
  });

  it('namespaces fingerprint, sequence, and content-hash checkpoint IDs', async () => {
    writeRun(tempDir, 'id-namespace-run', [
      {
        time: '2026-08-22T00:00:00.000Z',
        type: 'run.created',
        runId: 'id-namespace-run',
        metadata: { fingerprint: 'id-namespace-run:1' },
      },
      {
        time: '2026-08-22T00:00:01.000Z',
        type: 'task.started',
        runId: 'id-namespace-run',
        taskId: 't1',
        metadata: { seq: 1 },
      },
      {
        time: '2026-08-22T00:00:02.000Z',
        type: 'task.progress',
        runId: 'id-namespace-run',
        taskId: 't1',
      },
    ]);
    const store = new PiCrewCheckpointStore({ rootDir: path.join(tempDir, 'pixel-agents-state') });
    const watcher = createCapturingWatcher(tempDir, [], store, () => true);

    watcher.start();

    expect(
      await waitUntil(
        () =>
          store.load(createProjectScope(tempDir).key, 'id-namespace-run')?.recentEventIds.length ===
          3,
      ),
    ).toBe(true);
    expect(store.load(createProjectScope(tempDir).key, 'id-namespace-run')?.recentEventIds).toEqual(
      ['fingerprint:id-namespace-run:1', 'seq:id-namespace-run:1', expect.stringMatching(/^hash:/)],
    );
    await watcher.stop();
  });

  it.each(['{not-json}\n', '{"time":"2026-08-22T00:00:02.000Z"'])(
    'does not skip a terminal history with a malformed or partial tail',
    (tail) => {
      const captured: Record<string, unknown>[] = [];
      const { eventsPath } = writeRun(tempDir, 'uncertain-terminal', [
        { time: '2026-08-22T00:00:00.000Z', type: 'run.created', runId: 'uncertain-terminal' },
        { time: '2026-08-22T00:00:01.000Z', type: 'run.completed', runId: 'uncertain-terminal' },
      ]);
      fs.appendFileSync(eventsPath, tail);
      const store = new PiCrewCheckpointStore({
        rootDir: path.join(tempDir, 'pixel-agents-state'),
      });
      const watcher = createCapturingWatcher(tempDir, captured, store);

      watcher.start();

      expect(captured).not.toEqual([]);
      expect(store.load(createProjectScope(tempDir).key, 'uncertain-terminal')).toBeNull();
      watcher.stop();
    },
  );
});

function writeRun(
  tempDir: string,
  runId: string,
  events: Record<string, unknown>[],
): { eventsPath: string } {
  const runDir = path.join(tempDir, '.crew', 'state', 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const eventsPath = path.join(runDir, 'events.jsonl');
  fs.writeFileSync(eventsPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  return { eventsPath };
}

function createCapturingWatcher(
  tempDir: string,
  captured: Record<string, unknown>[],
  checkpointStore: PiCrewCheckpointStore,
  ...confirmations: Array<boolean | (() => boolean)>
): PiCrewEventWatcher {
  let confirmationIndex = 0;
  const watcher = new PiCrewEventWatcher({
    projectScopes: [createProjectScope(tempDir)],
    serverUrl: 'http://127.0.0.1:1234',
    authToken: 'test-token',
    checkpointStore,
    outboxFactory: () =>
      createCapturingOutbox(captured, () => {
        const confirmation = confirmations[Math.min(confirmationIndex, confirmations.length - 1)];
        if (typeof confirmation === 'function') return confirmation();
        confirmationIndex += 1;
        return confirmation === true;
      }),
  });
  return watcher;
}

function createCapturingOutbox(
  captured: Record<string, unknown>[],
  isConfirmed: () => boolean,
): {
  enqueue: (item: HookOutboxItem) => Promise<HookDeliveryResult>;
  drain: () => Promise<boolean>;
} {
  return {
    enqueue: (item) => {
      captured.push(...item.payloads.map((payload) => payload.body));
      return Promise.resolve(
        isConfirmed()
          ? { outcome: 'success', attempts: item.payloads.length, permanentFailures: 0 }
          : { outcome: 'retryable_failure', attempts: item.payloads.length, permanentFailures: 0 },
      );
    },
    drain: async () => true,
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

async function nextTick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; settled: boolean } {
  let resolve!: (value: T) => void;
  let settled = false;
  return {
    promise: new Promise<T>(
      (done) =>
        (resolve = (value) => {
          settled = true;
          done(value);
        }),
    ),
    resolve,
    get settled() {
      return settled;
    },
  };
}
