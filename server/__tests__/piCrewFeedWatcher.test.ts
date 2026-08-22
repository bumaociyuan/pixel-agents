import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProjectScope } from '../../core/src/projectScope.js';
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
      projectDirs: [tempDir],
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

    // The watcher polls asynchronously; give it time to fire
    // We expect onNewProject to be called with tempDir
    expect(newProjects).toContain(tempDir);

    watcher.stop();
  });

  it('does not fire onNewProject for already-known project directories', () => {
    const newProjects: string[] = [];
    const watcher = new PiCrewEventWatcher({
      projectDirs: [tempDir],
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
    expect(newProjects).toContain(tempDir);

    // Second poll: should NOT trigger onNewProject again
    const beforeCount = newProjects.length;
    watcher.start(); // re-start triggers another poll
    expect(newProjects.length).toBe(beforeCount);

    watcher.stop();
  });

  it('handles missing .crew/state/runs/ directory gracefully', () => {
    const newProjects: string[] = [];
    const watcher = new PiCrewEventWatcher({
      projectDirs: [tempDir], // tempDir has no .crew/ subdirectory
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

  it('tracks discovered runs via scanRunsDir', () => {
    const watcher = new PiCrewEventWatcher({
      projectDirs: [tempDir],
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

  it('prunes a stale cancelled run', () => {
    const watcher = new PiCrewEventWatcher({
      projectDirs: [tempDir],
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

    const states = (watcher as unknown as { runStates: Map<string, unknown> }).runStates;
    expect(states).toHaveLength(0);
    watcher.stop();
  });

  it('forwards a run mismatch diagnostic to hook normalization', () => {
    const watcher = new PiCrewEventWatcher({
      projectDirs: [tempDir],
      serverUrl: 'http://127.0.0.1:1234',
      authToken: 'test-token',
    });
    const captured: Record<string, unknown>[] = [];
    (watcher as unknown as { postToHook: (payload: Record<string, unknown>) => void }).postToHook =
      (payload) => captured.push(payload);
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

  it('persists an offset only after a delivery confirmation and then suppresses replay', () => {
    const { eventsPath } = writeRun(tempDir, 'confirmed-run', [
      { time: '2026-08-22T00:00:00.000Z', type: 'run.created', runId: 'confirmed-run' },
    ]);
    const store = new PiCrewCheckpointStore({ rootDir: path.join(tempDir, 'pixel-agents-state') });
    const unconfirmed = createCapturingWatcher(tempDir, [], store, () => false);

    unconfirmed.start();

    (unconfirmed as unknown as { poll: () => void }).poll();

    expect(store.load(createProjectScope(tempDir).key, 'confirmed-run')).toBeNull();
    unconfirmed.stop();

    const confirmedPayloads: Record<string, unknown>[] = [];
    const confirmed = createCapturingWatcher(tempDir, confirmedPayloads, store, () => true);
    confirmed.start();

    expect(confirmedPayloads).toHaveLength(2);
    expect(store.load(createProjectScope(tempDir).key, 'confirmed-run')?.committedOffset).toBe(
      fs.statSync(eventsPath).size,
    );
    confirmed.stop();

    const replayedPayloads: Record<string, unknown>[] = [];
    const restarted = createCapturingWatcher(tempDir, replayedPayloads, store, () => true);
    restarted.start();

    expect(replayedPayloads).toEqual([]);
    restarted.stop();
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

  it('re-emits the original payload from the same watcher after a failed confirmation', () => {
    writeRun(tempDir, 'retry-same-watcher', [
      { time: '2026-08-22T00:00:00.000Z', type: 'run.created', runId: 'retry-same-watcher' },
    ]);
    const store = new PiCrewCheckpointStore({ rootDir: path.join(tempDir, 'pixel-agents-state') });
    let confirmed = false;
    const captured: Record<string, unknown>[] = [];
    const watcher = createCapturingWatcher(tempDir, captured, store, () => confirmed);

    watcher.start();
    confirmed = true;
    (watcher as unknown as { poll: () => void }).poll();

    expect(captured.map((payload) => payload.hook_event_name)).toEqual([
      'CrewSessionStart',
      'CrewPlanStart',
      'CrewSessionStart',
      'CrewPlanStart',
    ]);
    expect(
      store.load(createProjectScope(tempDir).key, 'retry-same-watcher')?.committedOffset,
    ).toBeGreaterThan(0);
    watcher.stop();
  });

  it('rebuilds lifecycle when rotation replaces a terminal run with a new active history', () => {
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
    fs.appendFileSync(
      eventsPath,
      `${JSON.stringify({ time: '2026-08-22T00:00:01.000Z', type: 'run.completed', runId: 'rotated-run', metadata: { fingerprint: 'old-completed' } })}\n`,
    );
    (watcher as unknown as { poll: () => void }).poll();
    fs.renameSync(eventsPath, `${eventsPath}.old`);
    fs.writeFileSync(
      eventsPath,
      `${JSON.stringify({ time: '2026-08-22T00:00:02.000Z', type: 'run.created', runId: 'rotated-run', metadata: { fingerprint: 'replacement-created' } })}\n`,
    );

    (watcher as unknown as { poll: () => void }).poll();

    expect(captured.slice(-2).map((payload) => payload.hook_event_name)).toEqual([
      'CrewSessionStart',
      'CrewPlanStart',
    ]);
    watcher.stop();
  });

  it('stores confirmed source event IDs and suppresses them after rotation', () => {
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
    fs.renameSync(eventsPath, `${eventsPath}.old`);
    fs.writeFileSync(
      eventsPath,
      `${JSON.stringify({ time: '2026-08-22T00:00:00.000Z', type: 'run.created', runId: 'dedupe-run', metadata: { fingerprint: 'same-source' } })}\n`,
    );

    (watcher as unknown as { poll: () => void }).poll();

    expect(store.load(createProjectScope(tempDir).key, 'dedupe-run')?.recentEventIds).toEqual([
      'fingerprint:same-source',
    ]);
    expect(captured).toHaveLength(2);
    watcher.stop();
  });

  it('rolls back reader and lifecycle when checkpoint save fails, then replays with a diagnostic', () => {
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
      projectDirs: [tempDir],
      serverUrl: 'http://127.0.0.1:1234',
      authToken: 'test-token',
      checkpointStore: store,
      onEventDeliveryConfirmed: () => true,
      onDiagnostic: (message) => diagnostics.push(message),
    });
    (watcher as unknown as { postToHook: (payload: Record<string, unknown>) => void }).postToHook =
      (payload) => captured.push(payload);

    watcher.start();
    failSave = false;
    (watcher as unknown as { poll: () => void }).poll();

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
    watcher.stop();
  });

  it('silently reapplies a rotated planner before a new terminal event', () => {
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

    expect(captured.slice(-2).map((payload) => payload.hook_event_name)).toEqual([
      'CrewPlanDone',
      'CrewSessionEnd',
    ]);
    watcher.stop();
  });

  it('namespaces fingerprint, sequence, and content-hash checkpoint IDs', () => {
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

    expect(store.load(createProjectScope(tempDir).key, 'id-namespace-run')?.recentEventIds).toEqual(
      ['fingerprint:id-namespace-run:1', 'seq:id-namespace-run:1', expect.stringMatching(/^hash:/)],
    );
    watcher.stop();
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
    projectDirs: [tempDir],
    serverUrl: 'http://127.0.0.1:1234',
    authToken: 'test-token',
    checkpointStore,
    onEventDeliveryConfirmed: () => {
      const confirmation = confirmations[Math.min(confirmationIndex, confirmations.length - 1)];
      if (typeof confirmation === 'function') return confirmation();
      confirmationIndex += 1;
      return confirmation === true;
    },
  });
  (watcher as unknown as { postToHook: (payload: Record<string, unknown>) => void }).postToHook = (
    payload,
  ) => captured.push(payload);
  return watcher;
}
