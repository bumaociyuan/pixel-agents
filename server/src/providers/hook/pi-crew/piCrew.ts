/** pi-crew hook provider. */

import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import { autoCreateRoomForProject } from '../pi-agent/autoRoom.js';
import { PI_CREW_CONSENT_DISCLOSURE, PI_CREW_CONSENT_HEADLINE } from './consentCopy.js';
import {
  PI_CREW_DISPLAY_NAME,
  PI_CREW_HOOK_EVENTS,
  PI_CREW_PROVIDER_ID,
  PI_CREW_TOOL_NAMES,
} from './constants.js';
import type { PiCrewEvent } from './feedTypes.js';
import { PiCrewEventWatcher } from './piCrewFeedWatcher.js';
import { applyPiCrewEvent, type HookPayload, type RunLifecycleState } from './piCrewLifecycle.js';

export function piCrewEventToHookPayloads(
  event: PiCrewEvent,
  state: RunLifecycleState,
): HookPayload[] {
  return applyPiCrewEvent(state, event);
}

let eventWatcher: PiCrewEventWatcher | null = null;

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
    case PI_CREW_HOOK_EVENTS.TASK_START:
      return {
        sessionId,
        event: {
          kind: 'toolStart',
          toolId: typeof raw.tool_id === 'string' ? raw.tool_id : `crew-task-${Date.now()}`,
          toolName: typeof raw.tool_name === 'string' ? raw.tool_name : PI_CREW_TOOL_NAMES.TASK,
          input:
            typeof raw.tool_input === 'object' && raw.tool_input !== null
              ? (raw.tool_input as Record<string, unknown>)
              : {},
        },
      };
    case PI_CREW_HOOK_EVENTS.TASK_DONE:
      return {
        sessionId,
        event: {
          kind: 'toolEnd',
          toolId: typeof raw.tool_id === 'string' ? raw.tool_id : 'current',
        },
      };
    case PI_CREW_HOOK_EVENTS.TASK_BLOCK:
      return { sessionId, event: { kind: 'permissionRequest' } };
    case PI_CREW_HOOK_EVENTS.TASK_UNBLOCK:
      return { sessionId, event: { kind: 'turnEnd' } };
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
      return { sessionId, event: { kind: 'progress', toolId: 'current', data: raw.data } };
    case 'CrewDiagnostic':
      return {
        sessionId,
        event: {
          kind: 'diagnostic',
          code: typeof raw.diagnostic_code === 'string' ? raw.diagnostic_code : 'unknown',
          data: raw.data,
        },
      };
    default:
      return null;
  }
}

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

async function installHooks(serverUrl: string, authToken: string): Promise<void> {
  const projectDirs = [process.cwd()];
  await eventWatcher?.stop();
  eventWatcher = new PiCrewEventWatcher({
    projectDirs,
    serverUrl,
    authToken,
    onNewProject: (projectDir) => autoCreateRoomForProject(projectDir),
  });
  eventWatcher.start();
  console.log('[Pixel Agents] pi-crew: hooks installed, event watcher started');
}

async function uninstallHooks(): Promise<void> {
  if (!eventWatcher) return;
  await eventWatcher.stop();
  eventWatcher = null;
  console.log('[Pixel Agents] pi-crew: hooks uninstalled, event watcher stopped');
}

export const piCrewProvider: HookProvider = {
  kind: 'hook',
  id: PI_CREW_PROVIDER_ID,
  displayName: PI_CREW_DISPLAY_NAME,
  protocolVersion: 1,
  normalizeHookEvent,
  installHooks,
  uninstallHooks,
  areHooksInstalled: () => Promise.resolve(eventWatcher?.isRunning() ?? false),
  consentDisclosure: () => ({
    headline: PI_CREW_CONSENT_HEADLINE,
    disclosure: PI_CREW_CONSENT_DISCLOSURE,
  }),
  formatToolStatus,
  permissionExemptTools: new Set([PI_CREW_TOOL_NAMES.PLAN, PI_CREW_TOOL_NAMES.REVIEW]),
  subagentToolNames: new Set(),
  readingTools: new Set([PI_CREW_TOOL_NAMES.REVIEW]),
  terminalNamePrefix: undefined,
};
