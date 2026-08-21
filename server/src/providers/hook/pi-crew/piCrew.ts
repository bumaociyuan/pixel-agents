/**
 * piCrewProvider: HookProvider for pi-crew (baphuongna).
 *
 * Maps pi-crew run events (events.jsonl) to Pixel Agents AgentEvents
 * so that pi-crew workers, the planner, and reviewers appear as pixel-art
 * characters in the office.
 *
 * Architecture:
 *   .crew/state/runs/<runId>/events.jsonl ──(poll)──→ PiCrewEventWatcher
 *                                                          ↓
 *                                                   POST /api/hooks/pi-crew
 *                                                          ↓
 *                                                  normalizeHookEvent
 *                                                          ↓
 *                                                     AgentEvent
 *                                                          ↓
 *                                                  HookEventHandler
 *                                                          ↓
 *                                                   AgentStateStore
 *                                                          ↓
 *                                                      Canvas
 *
 * The event watcher is started in installHooks() and stopped in uninstallHooks().
 * Events flow through the standard HTTP hook pipeline so the runtime needs zero
 * changes to support this provider.
 */

import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import { PI_CREW_CONSENT_DISCLOSURE, PI_CREW_CONSENT_HEADLINE } from './consentCopy.js';
import {
  PI_CREW_DISPLAY_NAME,
  PI_CREW_HOOK_EVENTS,
  PI_CREW_PROVIDER_ID,
  PI_CREW_TOOL_NAMES,
} from './constants.js';
import type { PiCrewEvent, RunEventState } from './feedTypes.js';
import { PiCrewEventWatcher } from './piCrewFeedWatcher.js';

// ── State ────────────────────────────────────────────────────

let eventWatcher: PiCrewEventWatcher | null = null;

// ── Event Mapping ────────────────────────────────────────────

/**
 * Map a pi-crew event to one or more raw hook payloads.
 *
 * Event → pixel-agent mapping strategy:
 *   task.started    → SessionStart + ToolStart (new character appears, sits at desk)
 *   task.completed  → ToolEnd + SessionEnd (character finishes, leaves)
 *   task.failed     → permissionRequest (blocked bubble)
 *   task.progress   → progress (update activity label)
 *   task.attention  → permissionRequest (needs attention bubble)
 *   task.cancelled  → SessionEnd (character removed)
 *   worker.spawned  → (informational, no character change)
 *   worker.exit     → (informational unless task already ended)
 *   run.created     → SessionStart for planner
 *   run.completed   → SessionEnd for all agents
 *   run.failed      → SessionEnd for all agents
 */
export function piCrewEventToHookPayloads(
  event: PiCrewEvent,
  state: RunEventState,
): Record<string, unknown>[] {
  switch (event.type) {
    // ── Run lifecycle ──

    case 'run.created': {
      const plannerName = 'crew-planner';
      const plannerSid = `pi-crew:${plannerName}`;
      return [
        {
          hook_event_name: PI_CREW_HOOK_EVENTS.SESSION_START,
          session_id: plannerSid,
          agent_name: plannerName,
          source: 'run.created',
          cwd: state.cwd,
        },
        {
          hook_event_name: PI_CREW_HOOK_EVENTS.PLAN_START,
          session_id: plannerSid,
          agent_name: plannerName,
          tool_name: PI_CREW_TOOL_NAMES.PLAN,
          tool_id: `crew-plan-${event.runId}`,
          tool_input: {
            description: event.message || 'Planning pi-crew run',
            runId: event.runId,
          },
        },
      ];
    }

    case 'run.completed':
    case 'run.failed': {
      const payloads: Record<string, unknown>[] = [];
      // End planner session
      payloads.push({
        hook_event_name: PI_CREW_HOOK_EVENTS.PLAN_DONE,
        session_id: 'pi-crew:crew-planner',
        agent_name: 'crew-planner',
        tool_id: `crew-plan-${event.runId}`,
      });
      payloads.push({
        hook_event_name: PI_CREW_HOOK_EVENTS.SESSION_END,
        session_id: 'pi-crew:crew-planner',
        agent_name: 'crew-planner',
        reason: event.type,
      });
      // End all worker sessions
      for (const agentName of state.knownAgents) {
        if (agentName === 'crew-planner') continue;
        payloads.push({
          hook_event_name: PI_CREW_HOOK_EVENTS.SESSION_END,
          session_id: `pi-crew:${agentName}`,
          agent_name: agentName,
          reason: event.type,
        });
      }
      return payloads;
    }

    // ── Task lifecycle ──

    case 'task.started': {
      const role = (event.data?.role as string) || 'worker';
      const agentName = (event.data?.agent as string) || role;
      const taskId = event.taskId || 'unknown';
      const sessionId = `pi-crew:${agentName}`;
      const taskDesc =
        (event.message as string) || (event.data?.description as string) || `Task ${taskId}`;

      const payloads: Record<string, unknown>[] = [];

      // Only create SessionStart if this agent wasn't already introduced
      // by task.parallel_start (single-task dispatch path)
      if (!state.knownAgents.has(agentName)) {
        state.knownAgents.add(agentName);
        state.taskAgents.set(taskId, agentName);
        payloads.push({
          hook_event_name: PI_CREW_HOOK_EVENTS.SESSION_START,
          session_id: sessionId,
          agent_name: agentName,
          source: 'task.started',
          cwd: event.data?.cwd || state.cwd,
          role: role,
          taskId: taskId,
          runId: event.runId,
        });
      }

      // Start the task tool (character sits at desk)
      payloads.push({
        hook_event_name: PI_CREW_HOOK_EVENTS.TASK_START,
        session_id: sessionId,
        agent_name: agentName,
        tool_name: roleToToolName(role),
        tool_id: `crew-task-${taskId}`,
        tool_input: {
          task_id: taskId,
          description: taskDesc,
          role: role,
          runId: event.runId,
        },
        task_id: taskId,
        task_title: taskDesc,
      });

      return payloads;
    }

    case 'task.completed': {
      const taskId = event.taskId || '';
      const agentName = state.taskAgents.get(taskId) || `worker-${taskId}`;
      const sessionId = `pi-crew:${agentName}`;
      return [
        {
          hook_event_name: PI_CREW_HOOK_EVENTS.TASK_DONE,
          session_id: sessionId,
          agent_name: agentName,
          tool_id: `crew-task-${taskId}`,
          task_id: taskId,
          task_title: event.message || '',
        },
        // Remove the worker character
        {
          hook_event_name: PI_CREW_HOOK_EVENTS.SESSION_END,
          session_id: sessionId,
          agent_name: agentName,
          reason: 'task.completed',
        },
      ];
    }

    case 'task.failed': {
      const taskId = event.taskId || '';
      const agentName = state.taskAgents.get(taskId) || `worker-${taskId}`;
      const sessionId = `pi-crew:${agentName}`;
      return [
        {
          hook_event_name: PI_CREW_HOOK_EVENTS.TASK_BLOCK,
          session_id: sessionId,
          agent_name: agentName,
          task_id: taskId,
          task_title: event.message || event.data?.error || 'Task failed',
        },
        {
          hook_event_name: PI_CREW_HOOK_EVENTS.SESSION_END,
          session_id: sessionId,
          agent_name: agentName,
          reason: 'task.failed',
        },
      ];
    }

    case 'task.needs_attention': {
      const taskId = event.taskId || '';
      const agentName = state.taskAgents.get(taskId) || `worker-${taskId}`;
      const sessionId = `pi-crew:${agentName}`;
      return [
        {
          hook_event_name: PI_CREW_HOOK_EVENTS.TASK_BLOCK,
          session_id: sessionId,
          agent_name: agentName,
          task_id: taskId,
          task_title: 'Needs attention',
        },
      ];
    }

    case 'task.cancelled': {
      const taskId = event.taskId || '';
      const agentName = state.taskAgents.get(taskId) || `worker-${taskId}`;
      return [
        {
          hook_event_name: PI_CREW_HOOK_EVENTS.SESSION_END,
          session_id: `pi-crew:${agentName}`,
          agent_name: agentName,
          reason: 'task.cancelled',
        },
      ];
    }

    case 'task.progress': {
      const taskId = event.taskId || (event.data?.taskId as string) || '';
      const agentName = state.taskAgents.get(taskId) || `worker-${taskId}`;
      return [
        {
          hook_event_name: PI_CREW_HOOK_EVENTS.PROGRESS,
          session_id: `pi-crew:${agentName}`,
          agent_name: agentName,
          tool_id: `crew-task-${taskId}`,
          data: {
            eventType: event.data?.eventType,
            activityState: event.data?.activityState,
            toolCount: event.data?.toolCount,
            turns: event.data?.turns,
            tokens: event.data?.tokens,
          },
        },
      ];
    }

    case 'task.attention': {
      const taskId = event.taskId || '';
      const agentName = state.taskAgents.get(taskId) || `worker-${taskId}`;
      return [
        {
          hook_event_name: PI_CREW_HOOK_EVENTS.TASK_BLOCK,
          session_id: `pi-crew:${agentName}`,
          agent_name: agentName,
          task_id: taskId,
          task_title: (event.data?.reason as string) || 'Attention needed',
        },
      ];
    }

    case 'task.parallel_start': {
      // Characters appear but don't sit yet — task.started will make them sit
      const taskIds = (event.data?.taskIds as string[]) || [];
      const roles = (event.data?.roles as string[]) || [];
      const payloads: Record<string, unknown>[] = [];
      for (let i = 0; i < taskIds.length; i++) {
        const tid = taskIds[i];
        const role = roles[i] || 'worker';
        const agentName = role;
        const sid = `pi-crew:${agentName}`;
        state.taskAgents.set(tid, agentName);
        state.knownAgents.add(agentName);
        // SessionStart only — character appears, task.started adds ToolStart
        payloads.push({
          hook_event_name: PI_CREW_HOOK_EVENTS.SESSION_START,
          session_id: sid,
          agent_name: agentName,
          source: 'task.parallel_start',
          cwd: state.cwd,
          role: role,
          taskId: tid,
          runId: event.runId,
        });
      }
      return payloads;
    }

    // ── Worker lifecycle (informational) ──

    case 'worker.spawned': {
      // Worker process spawned — informational only, character already created
      // by task.started or task.parallel_start
      return [];
    }

    case 'worker.exit':
    case 'worker.close':
    case 'worker.cancelled':
    case 'worker.spawn_error':
    case 'worker.response_timeout':
    case 'worker.final_drain':
    case 'worker.hard_kill':
      // Worker lifecycle events — informational, character lifecycle managed
      // by task.{completed,failed,cancelled}
      return [];

    default:
      return [];
  }
}

// ── Role → Tool Name Mapping ─────────────────────────────────

function roleToToolName(role: string): string {
  switch (role) {
    case 'planner':
      return PI_CREW_TOOL_NAMES.PLAN;
    case 'reviewer':
    case 'security-reviewer':
    case 'code-reviewer':
    case 'quality-reviewer':
    case 'cold-verifier':
      return PI_CREW_TOOL_NAMES.REVIEW;
    default:
      return PI_CREW_TOOL_NAMES.TASK;
  }
}

// ── normalizeHookEvent ───────────────────────────────────────

function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const eventName = raw.hook_event_name;
  const sessionId = raw.session_id;
  if (typeof eventName !== 'string' || typeof sessionId !== 'string') return null;

  switch (eventName) {
    case PI_CREW_HOOK_EVENTS.SESSION_START:
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: typeof raw.source === 'string' ? raw.source : undefined,
          cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
          preferredArea: typeof raw.preferred_area === 'string' ? raw.preferred_area : undefined,
        },
      };

    case PI_CREW_HOOK_EVENTS.SESSION_END:
      return {
        sessionId,
        event: {
          kind: 'sessionEnd',
          reason: typeof raw.reason === 'string' ? raw.reason : undefined,
        },
      };

    case PI_CREW_HOOK_EVENTS.TASK_START: {
      const toolName = typeof raw.tool_name === 'string' ? raw.tool_name : PI_CREW_TOOL_NAMES.TASK;
      const toolId = typeof raw.tool_id === 'string' ? raw.tool_id : `crew-task-${Date.now()}`;
      const toolInput =
        typeof raw.tool_input === 'object' && raw.tool_input !== null
          ? (raw.tool_input as Record<string, unknown>)
          : {};
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId,
          toolName,
          input: toolInput,
        },
      };
    }

    case PI_CREW_HOOK_EVENTS.TASK_DONE: {
      const toolId = typeof raw.tool_id === 'string' ? raw.tool_id : 'current';
      return {
        sessionId,
        event: { kind: 'toolEnd', toolId },
      };
    }

    case PI_CREW_HOOK_EVENTS.TASK_BLOCK:
      return {
        sessionId,
        event: { kind: 'permissionRequest' },
      };

    case PI_CREW_HOOK_EVENTS.TASK_UNBLOCK:
      return {
        sessionId,
        event: { kind: 'turnEnd' },
      };

    case PI_CREW_HOOK_EVENTS.PLAN_START:
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId: typeof raw.tool_id === 'string' ? raw.tool_id : `crew-plan-${Date.now()}`,
          toolName: PI_CREW_TOOL_NAMES.PLAN,
          input:
            typeof raw.tool_input === 'object' && raw.tool_input !== null
              ? (raw.tool_input as Record<string, unknown>)
              : {},
        },
      };

    case PI_CREW_HOOK_EVENTS.PLAN_DONE:
      return {
        sessionId,
        event: {
          kind: 'toolEnd',
          toolId: typeof raw.tool_id === 'string' ? raw.tool_id : 'current',
        },
      };

    case PI_CREW_HOOK_EVENTS.PROGRESS:
      return {
        sessionId,
        event: {
          kind: 'progress',
          toolId: 'current',
          data: raw.data,
        },
      };

    default:
      return null;
  }
}

// ── formatToolStatus ─────────────────────────────────────────

function formatToolStatus(toolName: string, input?: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case PI_CREW_TOOL_NAMES.TASK: {
      const desc = typeof inp.description === 'string' ? inp.description : '';
      const role = typeof inp.role === 'string' ? ` [${inp.role}]` : '';
      return desc ? `pi-crew: ${desc}${role}` : 'Working on pi-crew task';
    }
    case PI_CREW_TOOL_NAMES.PLAN:
      return 'Planning pi-crew tasks';
    case PI_CREW_TOOL_NAMES.REVIEW:
      return 'Reviewing pi-crew task';
    default:
      return `pi-crew: ${toolName}`;
  }
}

// ── Installer wrappers ───────────────────────────────────────

async function installHooks(serverUrl: string, authToken: string): Promise<void> {
  const projectDirs = [process.cwd()];

  if (eventWatcher) {
    eventWatcher.stop();
  }

  eventWatcher = new PiCrewEventWatcher({
    projectDirs,
    serverUrl,
    authToken,
  });
  eventWatcher.start();
  console.log('[Pixel Agents] pi-crew: hooks installed, event watcher started');
}

async function uninstallHooks(): Promise<void> {
  if (eventWatcher) {
    eventWatcher.stop();
    eventWatcher = null;
    console.log('[Pixel Agents] pi-crew: hooks uninstalled, event watcher stopped');
  }
}

function areHooksInstalled(): Promise<boolean> {
  return Promise.resolve(eventWatcher?.isRunning() ?? false);
}

function consentDisclosure(): { headline: string; disclosure: string } {
  return {
    headline: PI_CREW_CONSENT_HEADLINE,
    disclosure: PI_CREW_CONSENT_DISCLOSURE,
  };
}

// ── The provider ─────────────────────────────────────────────

export const piCrewProvider: HookProvider = {
  kind: 'hook',
  id: PI_CREW_PROVIDER_ID,
  displayName: PI_CREW_DISPLAY_NAME,
  protocolVersion: 1,

  normalizeHookEvent,

  installHooks,
  uninstallHooks,
  areHooksInstalled,
  consentDisclosure,

  formatToolStatus,
  permissionExemptTools: new Set([PI_CREW_TOOL_NAMES.PLAN, PI_CREW_TOOL_NAMES.REVIEW]),
  subagentToolNames: new Set(),
  readingTools: new Set([PI_CREW_TOOL_NAMES.REVIEW]),
  terminalNamePrefix: undefined,
};
