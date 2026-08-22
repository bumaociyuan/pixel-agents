// PiCrewEventWatcher: scans .crew/state/runs/<runId>/events.jsonl for pi-crew
// (baphuongna) run events and dispatches them to the hook endpoint.
//
// Self-contained poll loop. The provider starts it in installHooks() and
// stops it in uninstallHooks(). Each new event is translated into a raw
// hook event and POSTed to the local pixel-agents hook endpoint, so it
// flows through the normal HookEventHandler pipeline.
//
// Architecture:
//   .crew/state/runs/<runId>/events.jsonl --(poll)--> PiCrewEventWatcher
//                                                       |
//                                                 POST /api/hooks/pi-crew
//                                                       |
//                                                normalizeHookEvent
//                                                       |
//                                                  AgentEvent

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';

import { createProjectScope, type ProjectScope } from '../../../../../core/src/projectScope.js';
import { readConfig } from '../../../configPersistence.js';
import { PI_CREW_FEED_POLL_MS } from './constants.js';
import type { PiCrewEvent } from './feedTypes.js';
import { IncrementalJsonlReader } from './jsonlReader.js';
import { piCrewEventToHookPayloads } from './piCrew.js';
import { PiCrewCheckpointStore } from './piCrewCheckpointStore.js';
import { createRunLifecycle, type RunLifecycleState } from './piCrewLifecycle.js';

export interface EventWatcherOptions {
  /** Project directories to scan for .crew/state/runs/. */
  projectDirs: string[];
  /** Hook server URL (e.g. http://127.0.0.1:3100). */
  serverUrl: string;
  /** Bearer token for the hook endpoint. */
  authToken: string;
  /** Called when a new project directory is discovered (auto-room creation). */
  onNewProject?: (projectDir: string) => void;
  /** Durable Pixel Agents state, injected by tests or an embedding host. */
  checkpointStore?: PiCrewCheckpointStore;
  /**
   * Temporary confirmation seam until Task 5's durable outbox exists. Return true only after every
   * payload from the source event is durably accepted; fire-and-forget HTTP has no confirmation and
   * therefore cannot advance a checkpoint.
   */
  onEventDeliveryConfirmed?: (
    event: PiCrewEvent,
    payloads: readonly Record<string, unknown>[],
  ) => boolean;
  /** Observable diagnostics for checkpoint corruption, reader recovery, and uncertain history. */
  onDiagnostic?: (message: string) => void;
}

interface WatchedRunState {
  runId: string;
  eventsPath: string;
  cwd: string;
  project: ProjectScope;
  projectKey: string;
  reader: IncrementalJsonlReader<PiCrewEvent>;
  lifecycle: RunLifecycleState;
  pendingTerminalOffset?: number;
}

export class PiCrewEventWatcher {
  private interval: ReturnType<typeof setInterval> | null = null;
  /** eventsPath → independent reader and lifecycle state. */
  private runStates = new Map<string, WatchedRunState>();
  /** Known project directories (for new-project detection). */
  private knownProjects = new Set<string>();
  private readonly checkpointStore: PiCrewCheckpointStore;
  private readonly onDiagnostic: (message: string) => void;

  constructor(private opts: EventWatcherOptions) {
    this.onDiagnostic =
      opts.onDiagnostic ?? ((message) => console.warn(`[Pixel Agents] pi-crew: ${message}`));
    this.checkpointStore =
      opts.checkpointStore ?? new PiCrewCheckpointStore({ onDiagnostic: this.onDiagnostic });
  }

  /** Start polling pi-crew event logs. */
  start(): void {
    if (this.interval) return;
    console.log(
      `[Pixel Agents] pi-crew: starting event watcher for ${this.opts.projectDirs.length} project(s)`,
    );

    this.interval = setInterval(() => this.poll(), PI_CREW_FEED_POLL_MS);
    this.poll();
  }

  /** Stop the poll loop. */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      console.log('[Pixel Agents] pi-crew: event watcher stopped');
    }
  }

  isRunning(): boolean {
    return this.interval !== null;
  }

  addProjectDir(dir: string): void {
    if (!this.opts.projectDirs.includes(dir)) {
      this.opts.projectDirs.push(dir);
    }
  }

  // ── Polling ──────────────────────────────────────────────

  private poll(): void {
    for (const dir of this.opts.projectDirs) {
      this.scanRunsDir(dir);
    }
    // Read new events from all tracked event logs
    for (const [eventsPath, state] of this.runStates) {
      try {
        this.readEvents(eventsPath, state);
      } catch (error) {
        this.onDiagnostic(`cannot process ${eventsPath}: ${errorMessage(error)}`);
      }
    }
    // Clean up completed runs that have been stale for a while
    this.pruneCompletedRuns();
  }

  /** Discover runs by scanning .crew/state/runs/. */
  private scanRunsDir(projectDir: string): void {
    const runsDir = path.join(projectDir, '.crew', 'state', 'runs');
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(runsDir, { withFileTypes: true });
    } catch {
      return; // No .crew/state/runs/ directory yet
    }

    // Detect new project directories for auto-room creation
    if (!this.knownProjects.has(projectDir)) {
      this.knownProjects.add(projectDir);
      console.log(`[Pixel Agents] pi-crew: new project detected: ${projectDir}`);
      this.opts.onNewProject?.(projectDir);
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runId = entry.name;
      const eventsPath = path.join(runsDir, runId, 'events.jsonl');

      if (this.runStates.has(eventsPath)) continue;

      try {
        // Verify the file exists (will throw if not)
        fs.statSync(eventsPath);
      } catch {
        // File doesn't exist yet — picked up on next poll
        continue;
      }

      const cwd = this.resolveRunCwd(projectDir, runId, runsDir);
      const project = createProjectScope(cwd);
      const checkpoint = this.checkpointStore.load(project.key, runId);
      let state: WatchedRunState | undefined;
      const reader = new IncrementalJsonlReader<PiCrewEvent>(eventsPath, {
        checkpoint: checkpoint ?? undefined,
        onDiagnostic: this.onDiagnostic,
        onReset: () => {
          if (state) state.lifecycle = createRunLifecycle(state.project, state.runId, state.cwd);
        },
      });

      if (!checkpoint) {
        const records = reader.readAvailable();
        const lastRecord = records.at(-1);
        if (
          lastRecord &&
          isTerminalRunEvent(lastRecord.value) &&
          !reader.hasUncertainTrailingData()
        ) {
          state = {
            runId,
            eventsPath,
            cwd,
            project,
            projectKey: project.key,
            reader,
            lifecycle: createRunLifecycle(project, runId, cwd),
            pendingTerminalOffset: lastRecord.endOffset,
          };
        } else if (lastRecord && isTerminalRunEvent(lastRecord.value)) {
          this.onDiagnostic(`terminal history has malformed or partial tail: ${eventsPath}`);
        }
      }

      state ??= {
        runId,
        eventsPath,
        cwd,
        project,
        projectKey: project.key,
        reader,
        lifecycle: createRunLifecycle(project, runId, cwd),
      };
      this.runStates.set(eventsPath, state);

      console.log(`[Pixel Agents] pi-crew: discovered run ${runId} in ${projectDir}`);
    }
  }

  /** Try to resolve the run's actual working directory from manifest.json. */
  private resolveRunCwd(projectDir: string, runId: string, runsDir: string): string {
    try {
      const manifestPath = path.join(runsDir, runId, 'manifest.json');
      const raw = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(raw) as { cwd?: string };
      if (manifest.cwd && typeof manifest.cwd === 'string') return manifest.cwd;
    } catch {
      // Fall through to projectDir
    }
    return projectDir;
  }

  // ── Event reading ────────────────────────────────────────

  private readEvents(_eventsPath: string, state: WatchedRunState): void {
    if (state.pendingTerminalOffset !== undefined) {
      const checkpoint = state.reader.prepareCommit(state.pendingTerminalOffset);
      if (!checkpoint) {
        this.onDiagnostic(`cannot prepare terminal checkpoint for ${state.eventsPath}`);
        return;
      }
      try {
        this.checkpointStore.save(state.projectKey, state.runId, checkpoint);
      } catch (error) {
        this.onDiagnostic(
          `cannot save terminal checkpoint for ${state.eventsPath}: ${errorMessage(error)}`,
        );
        return;
      }
      state.reader.finalizeCommit(checkpoint);
      state.pendingTerminalOffset = undefined;
      return;
    }

    for (const record of state.reader.readAvailable()) {
      const eventId = sourceEventId(record.value);
      if (state.reader.hasRecentEventId(eventId)) {
        const nextLifecycle = cloneLifecycle(state.lifecycle);
        piCrewEventToHookPayloads(record.value, nextLifecycle);
        const checkpoint = state.reader.prepareCommit(record.endOffset);
        if (!checkpoint) break;
        this.checkpointStore.save(state.projectKey, state.runId, checkpoint);
        state.reader.finalizeCommit(checkpoint);
        state.lifecycle = nextLifecycle;
        continue;
      }

      const nextLifecycle = cloneLifecycle(state.lifecycle);
      const payloads = this.dispatchEvent(record.value, state, nextLifecycle);
      if (this.opts.onEventDeliveryConfirmed?.(record.value, payloads) !== true) break;

      const checkpoint = state.reader.prepareCommit(record.endOffset, eventId);
      if (!checkpoint) break;
      this.checkpointStore.save(state.projectKey, state.runId, checkpoint);
      state.reader.finalizeCommit(checkpoint);
      state.lifecycle = nextLifecycle;
    }
  }

  // ── Event dispatch ───────────────────────────────────────

  private dispatchEvent(
    event: PiCrewEvent,
    state: WatchedRunState,
    lifecycle: RunLifecycleState,
  ): Record<string, unknown>[] {
    const projectDir = state.cwd;

    const preferredArea = this.findPreferredArea(projectDir);

    const payloads = piCrewEventToHookPayloads(event, lifecycle);
    for (const payload of payloads) {
      if (preferredArea && payload.hook_event_name === 'CrewSessionStart') {
        payload.preferred_area = preferredArea;
      }
      this.postToHook(payload);
    }
    return payloads;
  }

  /** Remove run states for completed runs that haven't been updated recently. */
  private pruneCompletedRuns(): void {
    const now = Date.now();
    const STALE_MS = 5 * 60 * 1000; // 5 minutes

    for (const [eventsPath, state] of this.runStates) {
      try {
        const stat = fs.statSync(eventsPath);
        if (now - stat.mtimeMs < STALE_MS) continue;
      } catch {
        continue;
      }

      // Check if the last event in the log is a terminal event
      const lastEvent = this.readLastEvent(eventsPath);
      if (lastEvent && isTerminalRunEvent(lastEvent)) {
        this.runStates.delete(eventsPath);
        console.log(`[Pixel Agents] pi-crew: pruned completed run ${state.runId}`);
      }
    }
  }

  private readLastEvent(eventsPath: string): PiCrewEvent | null {
    const reader = new IncrementalJsonlReader<PiCrewEvent>(eventsPath, {
      onDiagnostic: this.onDiagnostic,
    });
    const lastEvent = reader.readAvailable().at(-1)?.value ?? null;
    return reader.hasUncertainTrailingData() ? null : lastEvent;
  }

  // ── Helpers ──────────────────────────────────────────────

  private findPreferredArea(projectDir: string): string | undefined {
    try {
      const config = readConfig();
      const areaMappings = config.standalone?.areaMappings ?? {};
      const folderName = path.basename(projectDir);
      const labels = areaMappings[folderName];
      if (labels && labels.length > 0) return labels[0];
    } catch {
      // Silently return undefined
    }
    return undefined;
  }

  private postToHook(payload: Record<string, unknown>): void {
    const body = JSON.stringify(payload);
    const url = new URL(`/api/hooks/${encodeURIComponent('pi-crew')}`, this.opts.serverUrl);

    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${this.opts.authToken}`,
        },
      },
      (res: import('node:http').IncomingMessage) => {
        res.resume();
        if (res.statusCode !== 200 && res.statusCode !== 204) {
          console.log(`[Pixel Agents] pi-crew: hook POST returned ${res.statusCode}`);
        }
      },
    );
    req.on('error', (e: Error) => {
      console.log(`[Pixel Agents] pi-crew: hook POST error: ${e.message}`);
    });
    req.write(body);
    req.end();
  }
}

function isTerminalRunEvent(event: PiCrewEvent): boolean {
  return (
    event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled'
  );
}

function cloneLifecycle(state: RunLifecycleState): RunLifecycleState {
  return {
    ...state,
    agents: new Map(
      [...state.agents].map(([key, agent]) => [
        key,
        { ...agent, activeTaskIds: new Set(agent.activeTaskIds) },
      ]),
    ),
    tasks: new Map([...state.tasks].map(([key, task]) => [key, { ...task }])),
    seenProgressFingerprints: new Set(state.seenProgressFingerprints),
    recentProgressFingerprintOrder: [...state.recentProgressFingerprintOrder],
    ...(state.planner ? { planner: { ...state.planner } } : {}),
  };
}

function sourceEventId(event: PiCrewEvent): string {
  if (event.metadata?.fingerprint) return `fingerprint:${event.metadata.fingerprint}`;
  if (Number.isInteger(event.metadata?.seq)) return `seq:${event.runId}:${event.metadata?.seq}`;
  return `hash:${createHash('sha256').update(stableJson(event)).digest('base64url')}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
