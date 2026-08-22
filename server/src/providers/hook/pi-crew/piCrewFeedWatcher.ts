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

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';

import { createProjectScope } from '../../../../../core/src/projectScope.js';
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
}

interface WatchedRunState {
  runId: string;
  eventsPath: string;
  cwd: string;
  projectKey: string;
  reader: IncrementalJsonlReader<PiCrewEvent>;
  lifecycle: RunLifecycleState;
}

export class PiCrewEventWatcher {
  private interval: ReturnType<typeof setInterval> | null = null;
  /** eventsPath → independent reader and lifecycle state. */
  private runStates = new Map<string, WatchedRunState>();
  /** Known project directories (for new-project detection). */
  private knownProjects = new Set<string>();
  private readonly checkpointStore: PiCrewCheckpointStore;

  constructor(private opts: EventWatcherOptions) {
    this.checkpointStore = opts.checkpointStore ?? new PiCrewCheckpointStore();
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
      } catch {
        // Event log may be temporarily unreadable
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
      const reader = new IncrementalJsonlReader<PiCrewEvent>(eventsPath, {
        checkpoint: checkpoint ?? undefined,
      });

      if (!checkpoint) {
        const records = reader.readAvailable();
        const lastRecord = records.at(-1);
        if (lastRecord && isTerminalRunEvent(lastRecord.value)) {
          reader.commit(lastRecord.endOffset);
          this.checkpointStore.save(project.key, runId, reader.snapshot());
        }
      }

      this.runStates.set(eventsPath, {
        runId,
        eventsPath,
        cwd,
        projectKey: project.key,
        reader,
        lifecycle: createRunLifecycle(project, runId, cwd),
      });

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
    for (const record of state.reader.readAvailable()) {
      const payloads = this.dispatchEvent(record.value, state);
      if (this.opts.onEventDeliveryConfirmed?.(record.value, payloads) !== true) continue;

      state.reader.commit(record.endOffset);
      this.checkpointStore.save(state.projectKey, state.runId, state.reader.snapshot());
    }
  }

  // ── Event dispatch ───────────────────────────────────────

  private dispatchEvent(event: PiCrewEvent, state: WatchedRunState): Record<string, unknown>[] {
    const projectDir = state.cwd;

    const preferredArea = this.findPreferredArea(projectDir);

    const payloads = piCrewEventToHookPayloads(event, state.lifecycle);
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
    return (
      new IncrementalJsonlReader<PiCrewEvent>(eventsPath).readAvailable().at(-1)?.value ?? null
    );
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
