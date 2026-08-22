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
  onEventDeliveryConfirmed?: () => boolean,
): PiCrewEventWatcher {
  const watcher = new PiCrewEventWatcher({
    projectDirs: [tempDir],
    serverUrl: 'http://127.0.0.1:1234',
    authToken: 'test-token',
    checkpointStore,
    onEventDeliveryConfirmed,
  });
  (watcher as unknown as { postToHook: (payload: Record<string, unknown>) => void }).postToHook = (
    payload,
  ) => captured.push(payload);
  return watcher;
}
