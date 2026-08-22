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
import * as path from 'node:path';

import {
  createProjectScope,
  dedupeProjectScopes,
  type ProjectScope,
} from '../../../../../core/src/projectScope.js';
import { readConfig } from '../../../configPersistence.js';
import { getProjectAreaLabels } from '../pi-agent/autoRoom.js';
import { PI_CREW_FEED_POLL_MS, PI_CREW_HOOK_DRAIN_TIMEOUT_MS } from './constants.js';
import type { PiCrewEvent } from './feedTypes.js';
import { type HookDeliveryResult, HookOutbox, type HookOutboxLike } from './hookOutbox.js';
import { IncrementalJsonlReader } from './jsonlReader.js';
import { piCrewEventToHookPayloads } from './piCrew.js';
import { PiCrewCheckpointStore } from './piCrewCheckpointStore.js';
import { createRunLifecycle, type RunLifecycleState } from './piCrewLifecycle.js';

export interface EventWatcherOptions {
  /** Canonical workspace scopes to scan for .crew/state/runs/. */
  projectScopes: readonly ProjectScope[];
  /** Hook server URL (e.g. http://127.0.0.1:3100). */
  serverUrl: string;
  /** Bearer token for the hook endpoint. */
  authToken: string;
  /** Called when a new project directory is discovered (auto-room creation). */
  onNewProject?: (projectDir: string) => void;
  /** Durable Pixel Agents state, injected by tests or an embedding host. */
  checkpointStore?: PiCrewCheckpointStore;
  /** Creates an independent, ordered queue for each discovered pi-crew run. */
  outboxFactory?: (runId: string) => HookOutboxLike;
  /** Test seam for pausing immediately before an event is added to its run outbox. */
  beforeOutboxEnqueue?: () => Promise<void>;
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
  outbox: HookOutboxLike;
  processing: boolean;
  enqueueSafe: boolean;
  projectAreaLabels: string[];
  pendingTerminalOffset?: number;
}

export class PiCrewEventWatcher {
  private interval: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private stopPromise: Promise<void> | undefined;
  /** eventsPath → independent reader and lifecycle state. */
  private runStates = new Map<string, WatchedRunState>();
  private readonly processingTasks = new Set<Promise<void>>();
  private readonly unsafeEnqueueStates = new Set<WatchedRunState>();
  private readonly safePointWaiters = new Set<() => void>();
  private readonly projectAreaLabelCache = new Map<string, string[]>();
  private projectAreaConfigSignature = '';
  /** Known project identities (for new-project detection). */
  private knownProjects = new Set<string>();
  private projectScopes: ProjectScope[];
  private readonly checkpointStore: PiCrewCheckpointStore;
  private readonly onDiagnostic: (message: string) => void;

  constructor(private opts: EventWatcherOptions) {
    this.onDiagnostic =
      opts.onDiagnostic ?? ((message) => console.warn(`[Pixel Agents] pi-crew: ${message}`));
    this.checkpointStore =
      opts.checkpointStore ?? new PiCrewCheckpointStore({ onDiagnostic: this.onDiagnostic });
    this.projectScopes = this.normalizeProjectScopes(opts.projectScopes);
  }

  /** Start polling pi-crew event logs. */
  start(): void {
    if (this.interval || this.stopping) return;
    console.log(
      `[Pixel Agents] pi-crew: starting event watcher for ${this.projectScopes.length} project(s)`,
    );

    this.interval = setInterval(() => this.poll(), PI_CREW_FEED_POLL_MS);
    this.poll();
  }

  /** Stop the poll loop. */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      console.log('[Pixel Agents] pi-crew: event watcher stopped');
    }
    this.stopPromise = this.finishStopping();
    return this.stopPromise;
  }

  isRunning(): boolean {
    return this.interval !== null;
  }

  /** Wait until every run has finished processing records already observed by a poll. */
  async waitForIdle(): Promise<void> {
    while (this.processingTasks.size > 0) {
      await Promise.all([...this.processingTasks]);
    }
  }

  /** Atomically replace the active workspace roots and release removed run resources. */
  async replaceProjectScopes(scopes: readonly ProjectScope[]): Promise<void> {
    this.projectScopes = this.normalizeProjectScopes(scopes);
    const activeKeys = new Set(this.projectScopes.map((scope) => scope.key));

    await this.waitForEnqueueSafePoints();
    await this.waitForIdle();

    const removed = [...this.runStates.entries()].filter(
      ([, state]) => !activeKeys.has(state.projectKey),
    );
    await Promise.all(
      removed.map(async ([eventsPath, state]) => {
        const drained = await state.outbox.drain(PI_CREW_HOOK_DRAIN_TIMEOUT_MS);
        if (!drained) {
          this.onDiagnostic(`hook outbox did not drain for removed project run ${eventsPath}`);
        }
        state.outbox.dispose?.();
        this.runStates.delete(eventsPath);
      }),
    );

    for (const projectKey of [...this.knownProjects]) {
      if (!activeKeys.has(projectKey)) this.knownProjects.delete(projectKey);
    }

    this.poll();
  }

  // ── Polling ──────────────────────────────────────────────

  private poll(): void {
    if (this.stopping) return;
    for (const scope of this.projectScopes) {
      this.scanRunsDir(scope);
    }
    // Read new events from all tracked event logs
    for (const [eventsPath, state] of this.runStates) {
      this.processRun(eventsPath, state);
    }
  }

  /** Discover runs by scanning .crew/state/runs/. */
  private scanRunsDir(project: ProjectScope): void {
    const projectDir = project.path;
    const runsDir = path.join(projectDir, '.crew', 'state', 'runs');
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(runsDir, { withFileTypes: true });
    } catch {
      return; // No .crew/state/runs/ directory yet
    }

    // Detect new project directories for auto-room creation
    if (!this.knownProjects.has(project.key)) {
      this.knownProjects.add(project.key);
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
            outbox: this.createOutbox(runId),
            processing: false,
            enqueueSafe: true,
            projectAreaLabels: this.resolveProjectAreaLabels(project),
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
        outbox: this.createOutbox(runId),
        processing: false,
        enqueueSafe: true,
        projectAreaLabels: this.resolveProjectAreaLabels(project),
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

  private processRun(eventsPath: string, state: WatchedRunState): void {
    if (this.stopping || state.processing) return;
    state.processing = true;
    const task = this.readEvents(eventsPath, state)
      .catch((error) => this.onDiagnostic(`cannot process ${eventsPath}: ${errorMessage(error)}`))
      .finally(() => {
        state.processing = false;
        this.pruneCompletedRuns();
      });
    this.processingTasks.add(task);
    void task.finally(() => this.processingTasks.delete(task));
  }

  private async readEvents(_eventsPath: string, state: WatchedRunState): Promise<void> {
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
      if (this.stopping) break;
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
      let result: HookDeliveryResult;
      try {
        this.markEnqueueUnsafe(state);
        if (this.opts.beforeOutboxEnqueue) await this.opts.beforeOutboxEnqueue();
        if (this.stopping) break;
        const delivery = state.outbox.enqueue({
          eventId,
          payloads: payloads.map((body, index) => ({
            idempotencyKey: `${eventId}:${index}`,
            body,
          })),
        });
        this.markEnqueueSafe(state);
        result = await delivery;
      } catch (error) {
        this.onDiagnostic(`cannot enqueue hook event ${eventId}: ${errorMessage(error)}`);
        break;
      } finally {
        this.markEnqueueSafe(state);
      }
      if (result.outcome === 'retryable_failure') break;

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
    state.projectAreaLabels = this.resolveProjectAreaLabels(state.project);
    const preferredArea = state.projectAreaLabels[0];

    const payloads = piCrewEventToHookPayloads(event, lifecycle);
    for (const payload of payloads) {
      if (preferredArea && payload.hook_event_name === 'CrewSessionStart') {
        payload.preferred_area = preferredArea;
      }
    }
    return payloads;
  }

  /** Remove run states for completed runs that haven't been updated recently. */
  private pruneCompletedRuns(): void {
    const now = Date.now();
    const STALE_MS = 5 * 60 * 1000; // 5 minutes

    for (const [eventsPath, state] of this.runStates) {
      if (state.processing) continue;
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

  private resolveProjectAreaLabels(project: ProjectScope): string[] {
    try {
      const config = readConfig();
      const signature = JSON.stringify([config.projectAreas, config.standalone.areaMappings]);
      if (signature !== this.projectAreaConfigSignature) {
        this.projectAreaConfigSignature = signature;
        this.projectAreaLabelCache.clear();
      }
      const cached = this.projectAreaLabelCache.get(project.key);
      if (cached) return [...cached];
      const labels = getProjectAreaLabels(project, 'standalone');
      this.projectAreaLabelCache.set(project.key, labels);
      return [...labels];
    } catch {
      // A malformed user config must not stop event delivery.
    }
    return [];
  }

  private createOutbox(runId: string): HookOutboxLike {
    if (this.opts.outboxFactory) return this.opts.outboxFactory(runId);
    return new HookOutbox({
      serverUrl: this.opts.serverUrl,
      authToken: this.opts.authToken,
      onDiagnostic: this.onDiagnostic,
    });
  }

  private normalizeProjectScopes(scopes: readonly ProjectScope[]): ProjectScope[] {
    return dedupeProjectScopes(
      scopes.map((scope) => createProjectScope(scope.path, scope.displayName)),
    );
  }

  private async finishStopping(): Promise<void> {
    await this.waitForEnqueueSafePoints();
    await Promise.all(
      [...this.runStates.values()].map(async (state) => {
        const drained = await state.outbox.drain(PI_CREW_HOOK_DRAIN_TIMEOUT_MS);
        if (!drained) this.onDiagnostic(`hook outbox did not drain for ${state.eventsPath}`);
      }),
    );
    await this.waitForIdle();
  }

  private markEnqueueUnsafe(state: WatchedRunState): void {
    state.enqueueSafe = false;
    this.unsafeEnqueueStates.add(state);
  }

  private markEnqueueSafe(state: WatchedRunState): void {
    if (state.enqueueSafe) return;
    state.enqueueSafe = true;
    this.unsafeEnqueueStates.delete(state);
    if (this.unsafeEnqueueStates.size !== 0) return;
    for (const resolve of this.safePointWaiters) resolve();
    this.safePointWaiters.clear();
  }

  private async waitForEnqueueSafePoints(): Promise<void> {
    while (this.unsafeEnqueueStates.size > 0) {
      await new Promise<void>((resolve) => this.safePointWaiters.add(resolve));
    }
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
