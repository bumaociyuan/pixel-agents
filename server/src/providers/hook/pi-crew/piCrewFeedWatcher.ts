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

import { readConfig } from '../../../configPersistence.js';
import { PI_CREW_FEED_POLL_MS } from './constants.js';
import type { PiCrewEvent, RunEventState } from './feedTypes.js';
import { piCrewEventToHookPayloads } from './piCrew.js';

export interface EventWatcherOptions {
  /** Project directories to scan for .crew/state/runs/. */
  projectDirs: string[];
  /** Hook server URL (e.g. http://127.0.0.1:3100). */
  serverUrl: string;
  /** Bearer token for the hook endpoint. */
  authToken: string;
  /** Called when a new project directory is discovered (auto-room creation). */
  onNewProject?: (projectDir: string) => void;
}

export class PiCrewEventWatcher {
  private interval: ReturnType<typeof setInterval> | null = null;
  /** eventsPath → RunEventState */
  private runStates = new Map<string, RunEventState>();
  /** Track task ownership across runs: taskId → agentName */
  private taskOwners = new Map<string, string>();
  /** Known project directories (for new-project detection). */
  private knownProjects = new Set<string>();

  constructor(private opts: EventWatcherOptions) {}

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

      // Start from the beginning for newly discovered runs
      // We use offset=0 to read all events that have already been written
      const offset = 0;
      try {
        // Verify the file exists (will throw if not)
        fs.statSync(eventsPath);
      } catch {
        // File doesn't exist yet — picked up on next poll
      }

      const cwd = this.resolveRunCwd(projectDir, runId, runsDir);

      this.runStates.set(eventsPath, {
        runId,
        eventsPath,
        cwd,
        offset,
        lineBuffer: '',
        taskAgents: new Map(),
        knownAgents: new Set(),
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

  private readEvents(eventsPath: string, state: RunEventState): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(eventsPath);
    } catch {
      return;
    }

    if (stat.size <= state.offset) return;

    const bytesToRead = Math.min(stat.size - state.offset, 64 * 1024);
    const buf = Buffer.alloc(bytesToRead);
    const fd = fs.openSync(eventsPath, 'r');
    fs.readSync(fd, buf, 0, bytesToRead, state.offset);
    fs.closeSync(fd);
    state.offset += bytesToRead;

    const text = state.lineBuffer + buf.toString('utf-8');
    const lines = text.split('\n');
    state.lineBuffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as PiCrewEvent;
        this.dispatchEvent(event, state);
      } catch {
        // Skip malformed lines
      }
    }
  }

  // ── Event dispatch ───────────────────────────────────────

  private dispatchEvent(event: PiCrewEvent, state: RunEventState): void {
    const projectDir = state.cwd;

    // Track agent names from task.started events
    if (event.type === 'task.started' && event.taskId && event.data) {
      const agentName =
        (event.data.agent as string) || (event.data.role as string) || `worker-${event.taskId}`;
      state.taskAgents.set(event.taskId, agentName);
      state.knownAgents.add(agentName);
    }

    // Handle task ownership transitions for cleanup
    if (
      event.type === 'task.completed' ||
      event.type === 'task.failed' ||
      event.type === 'task.cancelled'
    ) {
      if (event.taskId) {
        this.taskOwners.delete(event.taskId);
      }
    }

    const preferredArea = this.findPreferredArea(projectDir);

    const payloads = piCrewEventToHookPayloads(event, state);
    for (const payload of payloads) {
      if (preferredArea && payload.hook_event_name === 'CrewSessionStart') {
        payload.preferred_area = preferredArea;
      }
      this.postToHook(payload);
    }
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
      if (lastEvent && (lastEvent.type === 'run.completed' || lastEvent.type === 'run.failed')) {
        // Send SessionEnd for all known agents
        for (const agent of state.knownAgents) {
          this.postToHook({
            hook_event_name: 'CrewSessionEnd',
            session_id: `pi-crew:${agent}`,
            agent_name: agent,
            reason: 'run.completed',
          });
        }
        this.runStates.delete(eventsPath);
        console.log(`[Pixel Agents] pi-crew: pruned completed run ${state.runId}`);
      }
    }
  }

  private readLastEvent(eventsPath: string): PiCrewEvent | null {
    try {
      const stat = fs.statSync(eventsPath);
      if (stat.size === 0) return null;
      // Read last ~4KB to find the last complete line
      const tailSize = Math.min(stat.size, 4096);
      const buf = Buffer.alloc(tailSize);
      const fd = fs.openSync(eventsPath, 'r');
      fs.readSync(fd, buf, 0, tailSize, stat.size - tailSize);
      fs.closeSync(fd);
      const lines = buf.toString('utf-8').split('\n').filter(Boolean);
      if (lines.length === 0) return null;
      return JSON.parse(lines[lines.length - 1]) as PiCrewEvent;
    } catch {
      return null;
    }
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
