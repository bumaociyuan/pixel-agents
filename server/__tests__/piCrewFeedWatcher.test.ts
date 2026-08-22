import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
});
