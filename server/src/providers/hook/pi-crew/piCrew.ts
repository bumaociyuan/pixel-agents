/**
 * piCrewProvider: HookProvider for pi-messenger Crew.
 *
 * Maps Crew activity feed events (feed.jsonl) to Pixel Agents AgentEvents
 * so that Crew workers, the planner, and the reviewer appear as pixel-art
 * characters in the office.
 *
 * Architecture:
 *   feed.jsonl ──(poll)──→ PiCrewFeedWatcher ──(POST)──→ /api/hooks/pi-crew
 *                                                              ↓
 *                                                     normalizeHookEvent
 *                                                              ↓
 *                                                        AgentEvent
 *                                                              ↓
 *                                                     HookEventHandler
 *                                                              ↓
 *                                                      AgentStateStore
 *                                                              ↓
 *                                                         Canvas
 *
 * The feed watcher is started in installHooks() and stopped in uninstallHooks().
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
import type { FeedEvent } from './feedTypes.js';
import { PiCrewFeedWatcher } from './piCrewFeedWatcher.js';

// ── State ────────────────────────────────────────────────────

let feedWatcher: PiCrewFeedWatcher | null = null;

// ── Event Mapping ────────────────────────────────────────────

/**
 * Map a feed event to one or more raw hook payloads.
 * A single feed event can produce multiple hook events (e.g. task.start
 * triggers both a sessionStart and a toolStart).
 */
export function feedEventToHookPayloads(
  event: FeedEvent,
  projectDir: string,
): Record<string, unknown>[] {
  const agentName = event.agent || 'unknown';
  const sessionId = `pi-crew:${agentName}`;
  const now = Date.now();

  switch (event.type) {
    case 'task.start': {
      const taskId = event.target || '';
      const taskTitle = event.preview || taskId;
      return [
        // Ensure the agent's session exists
        {
          hook_event_name: PI_CREW_HOOK_EVENTS.SESSION_START,
          session_id: sessionId,
          agent_name: agentName,
          source: 'task.start',
          cwd: projectDir,
        },
        // Start the task tool
        {
          hook_event_name: PI_CREW_HOOK_EVENTS.TASK_START,
          session_id: sessionId,
          agent_name: agentName,
          tool_name: PI_CREW_TOOL_NAMES.TASK,
          tool_id: `crew-task-${taskId}-${now}`,
          tool_input: { task_id: taskId, description: taskTitle },
          task_id: taskId,
          task_title: taskTitle,
        },
      ];
    }

    case 'task.done': {
      const taskId = event.target || '';
      return [
        {
          hook_event_name: PI_CREW_HOOK_EVENTS.TASK_DONE,
          session_id: sessionId,
          agent_name: agentName,
          tool_id: `crew-task-${taskId}`,
          task_id: taskId,
          task_title: event.preview || '',
        },
        // Remove the worker character after task completes
        {
          hook_event_name: PI_CREW_HOOK_EVENTS.SESSION_END,
          session_id: sessionId,
          agent_name: agentName,
          reason: 'task.done',
        },
      ];
    }

    case 'task.block': {
      const taskId = event.target || '';
      return [
        {
          hook_event_name: PI_CREW_HOOK_EVENTS.TASK_BLOCK,
          session_id: sessionId,
          agent_name: agentName,
          task_id: taskId,
          task_title: event.preview || '',
        },
      ];
    }

    case 'task.unblock': {
      return [
        {
          hook_event_name: PI_CREW_HOOK_EVENTS.TASK_UNBLOCK,
          session_id: sessionId,
          agent_name: agentName,
        },
      ];
    }

    case 'plan.start': {
      return [
        {
          hook_event_name: PI_CREW_HOOK_EVENTS.SESSION_START,
          session_id: `pi-crew:crew-planner`,
          agent_name: 'crew-planner',
          source: 'plan.start',
          cwd: projectDir,
        },
        {
          hook_event_name: PI_CREW_HOOK_EVENTS.PLAN_START,
          session_id: `pi-crew:crew-planner`,
          agent_name: 'crew-planner',
          tool_name: PI_CREW_TOOL_NAMES.PLAN,
          tool_id: `crew-plan-${now}`,
          tool_input: { description: event.preview || 'Planning' },
        },
      ];
    }

    case 'plan.done': {
      return [
        {
          hook_event_name: PI_CREW_HOOK_EVENTS.PLAN_DONE,
          session_id: `pi-crew:crew-planner`,
          agent_name: 'crew-planner',
          tool_id: 'crew-plan',
        },
        // Remove the planner character after planning completes
        {
          hook_event_name: PI_CREW_HOOK_EVENTS.SESSION_END,
          session_id: `pi-crew:crew-planner`,
          agent_name: 'crew-planner',
          reason: 'plan.done',
        },
      ];
    }

    case 'plan.pass.start':
    case 'plan.pass.done':
    case 'plan.review.start':
    case 'plan.review.done': {
      return [
        {
          hook_event_name: PI_CREW_HOOK_EVENTS.PROGRESS,
          session_id: `pi-crew:crew-planner`,
          agent_name: 'crew-planner',
          tool_id: 'crew-plan',
          data: { type: event.type, preview: event.preview },
        },
      ];
    }

    case 'task.review': {
      return [
        {
          hook_event_name: PI_CREW_HOOK_EVENTS.SESSION_START,
          session_id: `pi-crew:crew-reviewer`,
          agent_name: 'crew-reviewer',
          source: 'task.review',
          cwd: projectDir,
        },
        {
          hook_event_name: PI_CREW_HOOK_EVENTS.TASK_START,
          session_id: `pi-crew:crew-reviewer`,
          agent_name: 'crew-reviewer',
          tool_name: PI_CREW_TOOL_NAMES.REVIEW,
          tool_id: `crew-review-${now}`,
          tool_input: { task_id: event.target, description: event.preview },
        },
      ];
    }

    case 'task.reset': {
      return [
        // Remove the worker character when task is reset (worker departed)
        {
          hook_event_name: PI_CREW_HOOK_EVENTS.SESSION_END,
          session_id: sessionId,
          agent_name: agentName,
          reason: 'task.reset',
        },
      ];
    }

    case 'task.approve':
    case 'task.reject': {
      // Approve/reject ends the review. Clean up the reviewer.
      const reviewerSid = 'pi-crew:crew-reviewer';
      return [
        {
          hook_event_name: PI_CREW_HOOK_EVENTS.TASK_DONE,
          session_id: reviewerSid,
          agent_name: 'crew-reviewer',
          tool_id: 'crew-review',
        },
        {
          hook_event_name: PI_CREW_HOOK_EVENTS.SESSION_END,
          session_id: reviewerSid,
          agent_name: 'crew-reviewer',
          reason: event.type,
        },
      ];
    }

    case 'task.split':
    case 'task.revise':
    case 'task.revise-tree': {
      return [
        {
          hook_event_name: PI_CREW_HOOK_EVENTS.PROGRESS,
          session_id: sessionId,
          agent_name: agentName,
          data: { type: event.type, preview: event.preview, target: event.target },
        },
      ];
    }

    case 'plan.cancel':
    case 'plan.failed': {
      return [
        {
          hook_event_name: PI_CREW_HOOK_EVENTS.SESSION_END,
          session_id: `pi-crew:crew-planner`,
          agent_name: 'crew-planner',
          reason: event.type,
        },
      ];
    }

    // Non-Crew events (join, leave, message, etc.) — silently skip
    default:
      return [];
  }
}

// ── normalizeHookEvent ───────────────────────────────────────

/**
 * Translate a pi-crew raw hook event into a normalized AgentEvent.
 * The raw events come from the feed watcher POSTing to the hook endpoint.
 */
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
      // Unblock is informational — clear the permission state
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
      return desc ? `Crew: ${desc}` : 'Working on Crew task';
    }
    case PI_CREW_TOOL_NAMES.PLAN:
      return 'Planning Crew tasks';
    case PI_CREW_TOOL_NAMES.REVIEW:
      return 'Reviewing Crew task';
    default:
      return `Crew: ${toolName}`;
  }
}

// ── Installer wrappers ───────────────────────────────────────

async function installHooks(serverUrl: string, authToken: string): Promise<void> {
  // Discover project directories from the current workspace. We use the
  // server's working directory as the single project dir for now.
  // In VS Code, the adapter would pass workspace folders.
  const projectDirs = [process.cwd()];

  if (feedWatcher) {
    feedWatcher.stop();
  }

  feedWatcher = new PiCrewFeedWatcher({
    projectDirs,
    serverUrl,
    authToken,
  });
  feedWatcher.start();
  console.log('[Pixel Agents] pi-crew: hooks installed, feed watcher started');
}

async function uninstallHooks(): Promise<void> {
  if (feedWatcher) {
    feedWatcher.stop();
    feedWatcher = null;
    console.log('[Pixel Agents] pi-crew: hooks uninstalled, feed watcher stopped');
  }
}

function areHooksInstalled(): Promise<boolean> {
  return Promise.resolve(feedWatcher?.isRunning() ?? false);
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
  // No terminal integration — Crew agents are virtual
  terminalNamePrefix: undefined,

  // No file fallback — feed watching is handled by the internal watcher
  // (no getSessionDirs, no sessionFilePattern, no parseTranscriptLine, no buildLaunchCommand)
};
