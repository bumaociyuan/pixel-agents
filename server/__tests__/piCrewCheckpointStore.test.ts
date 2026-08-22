import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JsonlCheckpoint } from '../src/providers/hook/pi-crew/jsonlReader.js';
import { PiCrewCheckpointStore } from '../src/providers/hook/pi-crew/piCrewCheckpointStore.js';

describe('PiCrewCheckpointStore', () => {
  let tempDir: string;
  let stateDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-crew-checkpoint-'));
    stateDir = path.join(tempDir, 'pixel-agents-state');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('round-trips a checkpoint in Pixel Agents state and bounds recent event IDs', () => {
    const store = new PiCrewCheckpointStore({ rootDir: stateDir });
    const checkpoint: JsonlCheckpoint = {
      committedOffset: 42,
      recentEventIds: Array.from({ length: 514 }, (_, index) => `event-${index}`),
    };

    store.save('project-a', 'run-1', checkpoint);

    expect(store.load('project-a', 'run-1')).toEqual({
      committedOffset: 42,
      recentEventIds: Array.from({ length: 512 }, (_, index) => `event-${index + 2}`),
    });
    expect(fs.existsSync(path.join(tempDir, '.crew'))).toBe(false);
  });

  it('isolates checkpoints by the complete project and run keys', () => {
    const store = new PiCrewCheckpointStore({ rootDir: stateDir });
    store.save('project-a', 'run-1', { committedOffset: 1, recentEventIds: ['a'] });
    store.save('project-a', 'run-2', { committedOffset: 2, recentEventIds: ['b'] });
    store.save('project-b', 'run-1', { committedOffset: 3, recentEventIds: ['c'] });

    expect(store.load('project-a', 'run-1')?.committedOffset).toBe(1);
    expect(store.load('project-a', 'run-2')?.committedOffset).toBe(2);
    expect(store.load('project-b', 'run-1')?.committedOffset).toBe(3);
  });

  it('falls back safely and emits a diagnostic for a corrupt checkpoint', () => {
    const diagnostics: string[] = [];
    const records: unknown[] = [];
    const store = new PiCrewCheckpointStore({
      rootDir: stateDir,
      onDiagnostic: (message) => diagnostics.push(message),
      onDiagnosticRecord: (diagnostic) => records.push(diagnostic),
    });
    store.save('project-a', 'run-1', { committedOffset: 1, recentEventIds: [] });
    const [checkpointPath] = findCheckpointFiles(stateDir);
    fs.writeFileSync(checkpointPath!, '{not-json');

    expect(store.load('project-a', 'run-1')).toBeNull();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('project-a');
    expect(diagnostics[0]).toContain('run-1');
    expect(records[0]).toMatchObject({
      category: 'checkpoint',
      projectKey: 'project-a',
      runId: 'run-1',
      file: checkpointPath,
    });
  });

  it('uses a visible default diagnostic when no callback is injected', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new PiCrewCheckpointStore({ rootDir: stateDir });
    store.save('project-a', 'run-1', { committedOffset: 1, recentEventIds: [] });
    const [checkpointPath] = findCheckpointFiles(stateDir);
    fs.writeFileSync(checkpointPath!, '{not-json');

    expect(store.load('project-a', 'run-1')).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('project=project-a'));
  });

  it('rejects a JSON checkpoint with an invalid reader identity', () => {
    const diagnostics: string[] = [];
    const store = new PiCrewCheckpointStore({
      rootDir: stateDir,
      onDiagnostic: (message) => diagnostics.push(message),
    });
    store.save('project-a', 'run-1', { committedOffset: 1, recentEventIds: [] });
    const [checkpointPath] = findCheckpointFiles(stateDir);
    fs.writeFileSync(
      checkpointPath!,
      JSON.stringify({
        committedOffset: 1,
        recentEventIds: [],
        fileIdentity: { dev: 'not-a-number' },
      }),
    );

    expect(store.load('project-a', 'run-1')).toBeNull();
    expect(diagnostics).toHaveLength(1);
  });

  it('atomically replaces the complete checkpoint without retaining a sibling temporary file', () => {
    const store = new PiCrewCheckpointStore({ rootDir: stateDir });
    store.save('project-a', 'run-1', { committedOffset: 1, recentEventIds: ['old-event'] });

    store.save('project-a', 'run-1', { committedOffset: 9, recentEventIds: ['event-9'] });

    expect(findCheckpointFiles(stateDir)).toHaveLength(1);
    expect(store.load('project-a', 'run-1')).toEqual({
      committedOffset: 9,
      recentEventIds: ['event-9'],
    });
    expect(fs.readdirSync(path.dirname(findCheckpointFiles(stateDir)[0]!))).not.toContain(
      expect.stringContaining('.tmp-'),
    );
  });

  it('removes only the requested project/run checkpoint', () => {
    const store = new PiCrewCheckpointStore({ rootDir: stateDir });
    store.save('project-a', 'run-1', { committedOffset: 1, recentEventIds: [] });
    store.save('project-a', 'run-2', { committedOffset: 2, recentEventIds: [] });

    store.remove('project-a', 'run-1');

    expect(store.load('project-a', 'run-1')).toBeNull();
    expect(store.load('project-a', 'run-2')?.committedOffset).toBe(2);
  });

  it.each(['writeFileSync', 'fsyncSync', 'closeSync', 'renameSync'] as const)(
    'cleans the temporary file when %s fails',
    (operation) => {
      const failure = new Error(`${operation} failed`);
      let failOnce = true;
      const files = {
        ...fs,
        [operation]: (...args: never[]) => {
          if (failOnce) {
            failOnce = false;
            throw failure;
          }
          return (fs[operation] as (...innerArgs: never[]) => unknown)(...args);
        },
      };
      const store = new PiCrewCheckpointStore({
        rootDir: stateDir,
        fileSystem: files,
      } as never);

      expect(() =>
        store.save('project-a', 'run-1', { committedOffset: 1, recentEventIds: [] }),
      ).toThrow(failure);
      expect(findTemporaryFiles(stateDir)).toEqual([]);
    },
  );
});

function findCheckpointFiles(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) files.push(...findCheckpointFiles(entryPath));
    else if (entry.name.endsWith('.json')) files.push(entryPath);
  }
  return files;
}

function findTemporaryFiles(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) files.push(...findTemporaryFiles(entryPath));
    else if (entry.name.includes('.tmp-')) files.push(entryPath);
  }
  return files;
}
