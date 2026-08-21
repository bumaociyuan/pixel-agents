/**
 * PiAgentWatcher: polls `herdr agent list` to discover running Pi agents
 * and dispatches session/tool events to the hook endpoint.
 *
 * Self-contained poll loop. Started in installHooks(), stopped in uninstallHooks().
 * Each discovered Pi agent becomes a character in the office; status transitions
 * (working ↔ idle) map to toolStart / toolEnd.
 *
 * Watches ALL pi agents across ALL project directories, not just the server's cwd.
 * When a new project is discovered, fires `onNewProject` so the caller can
 * auto-create an area/room in the office layout.
 */

import { execFile } from 'node:child_process';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';

import { readConfig } from '../../../configPersistence.js';
import {
  PI_AGENT_HOOK_EVENTS,
  PI_AGENT_POLL_MS,
  PI_AGENT_PROVIDER_ID,
  PI_AGENT_TOOL_NAMES,
} from './constants.js';

// ── Types ────────────────────────────────────────────────────

/** A single pi agent pane from herdr's snapshot. */
interface PiAgentPane {
  pane_id: string;
  agent: string;
  agent_status: 'idle' | 'working' | 'blocked' | 'unknown';
  cwd: string;
  label?: string;
  tokens?: { chat?: string };
  workspace_id: string;
}

interface HerdrSnapshot {
  agents?: PiAgentPane[];
  panes?: PiAgentPane[];
}

// ── Options ──────────────────────────────────────────────────

export interface PiAgentWatcherOptions {
  /** Hook server URL (e.g. http://127.0.0.1:3100). */
  serverUrl: string;
  /** Bearer token for the hook endpoint. */
  authToken: string;
  /** Path to the herdr binary (default: 'herdr'). */
  herdrBin?: string;
  /** Called when a new project directory is discovered. */
  onNewProject?: (projectDir: string) => void;
}

// ── Watcher ──────────────────────────────────────────────────

const PI_AGENT_TOOL_END_DEBOUNCE_MS = 5000;

export class PiAgentWatcher {
  private interval: ReturnType<typeof setInterval> | null = null;
  /** pane_id → known state */
  private knownAgents = new Map<string, PiAgentPane>();
  /** Set of known project directories (for new-project detection) */
  private knownProjects = new Set<string>();
  /** pane_id → pending toolEnd timeout */
  private pendingToolEnds = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private opts: PiAgentWatcherOptions) {}

  /** Start polling herdr for pi agents. */
  start(): void {
    if (this.interval) return;
    console.log('[Pixel Agents] pi-agent: starting herdr watcher');

    this.interval = setInterval(() => this.poll(), PI_AGENT_POLL_MS);
    this.poll();
  }

  /** Stop the poll loop. */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      // Clear pending toolEnds
      for (const [paneId, timeout] of this.pendingToolEnds) {
        clearTimeout(timeout);
        const agent = this.knownAgents.get(paneId);
        if (agent) this.sendToolEnd(agent);
      }
      this.pendingToolEnds.clear();
      for (const paneId of this.knownAgents.keys()) {
        this.sendSessionEnd(paneId, 'uninstalled');
      }
      this.knownAgents.clear();
      this.knownProjects.clear();
      console.log('[Pixel Agents] pi-agent: watcher stopped');
    }
  }

  isRunning(): boolean {
    return this.interval !== null;
  }

  // ── Polling ─────────────────────────────────────────────

  private poll(): void {
    const bin = this.opts.herdrBin ?? 'herdr';
    execFile(bin, ['agent', 'list'], { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) {
        console.log(`[Pixel Agents] pi-agent: ${stderr ? stderr.trim() : err.message}`);
        return;
      }
      try {
        const data = JSON.parse(stdout) as { result?: HerdrSnapshot };
        const panes = data.result?.agents ?? [];
        this.processSnapshot(panes as PiAgentPane[]);
      } catch {
        // Malformed JSON — skip
      }
    });
  }

  private processSnapshot(panes: PiAgentPane[]): void {
    const seenIds = new Set<string>();

    for (const pane of panes) {
      if (pane.agent !== 'pi') continue;
      if (pane.agent_status === 'unknown') continue;

      // Detect new projects
      if (pane.cwd && !this.knownProjects.has(pane.cwd)) {
        this.knownProjects.add(pane.cwd);
        console.log(`[Pixel Agents] pi-agent: new project detected: ${pane.cwd}`);
        this.opts.onNewProject?.(pane.cwd);
      }

      seenIds.add(pane.pane_id);
      const known = this.knownAgents.get(pane.pane_id);

      if (!known) {
        this.sendSessionStart(pane);
        if (pane.agent_status === 'working') {
          // Working agents: show tool activity at desk
          this.sendToolStart(pane);
        } else {
          // Idle/blocked agents: confirm session with a dummy event
          // so they appear but NOT at their desks (no active tool)
          this.sendConfirm(pane);
          if (pane.agent_status === 'blocked') {
            this.sendBlocked(pane);
          }
        }
      } else if (known.agent_status !== pane.agent_status) {
        this.handleTransition(known, pane);
      }

      this.knownAgents.set(pane.pane_id, pane);
    }

    // Remove disappeared agents
    for (const [paneId, agent] of this.knownAgents) {
      if (!seenIds.has(paneId)) {
        this.sendToolEnd(agent);
        this.sendSessionEnd(paneId, 'disappeared');
        this.knownAgents.delete(paneId);
      }
    }
  }

  private handleTransition(oldState: PiAgentPane, newState: PiAgentPane): void {
    console.log(
      `[Pixel Agents] pi-agent: transition ${newState.pane_id}: ${oldState.agent_status} → ${newState.agent_status}`,
    );
    if (oldState.agent_status === 'idle' && newState.agent_status === 'working') {
      this.sendToolStart(newState);
    }
    if (oldState.agent_status === 'working' && newState.agent_status === 'idle') {
      // Debounce: only send toolEnd after a delay, cancel if agent starts working again
      const existing = this.pendingToolEnds.get(newState.pane_id);
      if (existing) clearTimeout(existing);
      const agent = newState;
      this.pendingToolEnds.set(
        newState.pane_id,
        setTimeout(() => {
          this.pendingToolEnds.delete(newState.pane_id);
          console.log(`[Pixel Agents] pi-agent: debounced toolEnd for ${newState.pane_id}`);
          this.sendToolEnd(agent);
        }, PI_AGENT_TOOL_END_DEBOUNCE_MS),
      );
    }
    // Cancel pending toolEnd if agent starts working again
    if (newState.agent_status === 'working') {
      const pending = this.pendingToolEnds.get(newState.pane_id);
      if (pending) {
        clearTimeout(pending);
        this.pendingToolEnds.delete(newState.pane_id);
        console.log(`[Pixel Agents] pi-agent: cancelled pending toolEnd for ${newState.pane_id}`);
      }
    }
    if (newState.agent_status === 'blocked') {
      this.sendBlocked(newState);
    }
    if (oldState.agent_status === 'blocked' && newState.agent_status === 'working') {
      this.sendToolEnd(oldState);
    }
  }

  // ── Event sending ───────────────────────────────────────

  private postToHook(payload: Record<string, unknown>): void {
    const body = JSON.stringify(payload);
    const url = new URL(
      `/api/hooks/${encodeURIComponent(PI_AGENT_PROVIDER_ID)}`,
      this.opts.serverUrl,
    );

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
      (res) => {
        res.resume();
        if (res.statusCode !== 200 && res.statusCode !== 204) {
          console.log(`[Pixel Agents] pi-agent: hook POST returned ${res.statusCode}`);
        }
      },
    );
    req.on('error', (e: Error) => {
      console.log(`[Pixel Agents] pi-agent: hook POST error: ${e.message}`);
    });
    req.write(body);
    req.end();
  }

  private sendSessionStart(agent: PiAgentPane): void {
    const label = agent.label ?? agent.tokens?.chat ?? 'pi';
    // Look up preferred area from config areaMappings based on cwd basename
    const preferredArea = findPreferredArea(agent.cwd);
    const payload: Record<string, unknown> = {
      hook_event_name: PI_AGENT_HOOK_EVENTS.SESSION_START,
      session_id: `pi-agent:${agent.pane_id}`,
      agent_name: label,
      cwd: agent.cwd,
      source: 'herdr',
    };
    if (preferredArea) {
      payload.preferred_area = preferredArea;
    }
    this.postToHook(payload);
  }

  private sendSessionEnd(paneId: string, reason: string): void {
    this.postToHook({
      hook_event_name: PI_AGENT_HOOK_EVENTS.SESSION_END,
      session_id: `pi-agent:${paneId}`,
      reason,
    });
  }

  private sendToolStart(agent: PiAgentPane): void {
    const taskDesc = agent.tokens?.chat ?? agent.label ?? 'Working';
    this.postToHook({
      hook_event_name: PI_AGENT_HOOK_EVENTS.TOOL_START,
      session_id: `pi-agent:${agent.pane_id}`,
      tool_name: PI_AGENT_TOOL_NAMES.DEFAULT,
      tool_id: `pi-${agent.pane_id}-${Date.now()}`,
      tool_input: { description: taskDesc },
    });
  }

  private sendToolEnd(agent: PiAgentPane): void {
    this.postToHook({
      hook_event_name: PI_AGENT_HOOK_EVENTS.TOOL_END,
      session_id: `pi-agent:${agent.pane_id}`,
    });
  }

  private sendBlocked(agent: PiAgentPane): void {
    this.postToHook({
      hook_event_name: PI_AGENT_HOOK_EVENTS.BLOCKED,
      session_id: `pi-agent:${agent.pane_id}`,
    });
  }

  /** Send turnEnd to confirm the session and put the agent in waiting state.
   *  Idle agents appear in the office but wander instead of sitting at desks. */
  private sendConfirm(agent: PiAgentPane): void {
    this.postToHook({
      hook_event_name: PI_AGENT_HOOK_EVENTS.TURN_END,
      session_id: `pi-agent:${agent.pane_id}`,
    });
  }
}

/** Look up the preferred area label for a project directory from config.
 *  Returns the first area label mapped to the project's basename, or undefined
 *  if no mapping exists. */
function findPreferredArea(cwd: string): string | undefined {
  try {
    const config = readConfig();
    const areaMappings = config.standalone?.areaMappings ?? {};
    const folderName = path.basename(cwd);
    const labels = areaMappings[folderName];
    if (labels && labels.length > 0) {
      return labels[0];
    }
  } catch {
    // Config read error: silently return undefined
  }
  return undefined;
}
