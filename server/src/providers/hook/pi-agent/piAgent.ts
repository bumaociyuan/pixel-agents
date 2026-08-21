/**
 * piAgentProvider: HookProvider for individual Pi coding agents.
 *
 * Polls `herdr agent list` to discover running Pi agent panes and maps
 * them to pixel-art characters. Status transitions (working ↔ idle) map
 * to toolStart / toolEnd events.
 *
 * Architecture:
 *   herdr ──(poll)──→ PiAgentWatcher ──(POST)──→ /api/hooks/pi-agent
 *                                                       ↓
 *                                               normalizeHookEvent
 *                                                       ↓
 *                                                  AgentEvent
 *                                                       ↓
 *                                               HookEventHandler
 *                                                       ↓
 *                                                AgentStateStore
 *                                                       ↓
 *                                                   Canvas
 */

import type { AgentEvent, HookProvider } from '../../../../../core/src/provider.js';
import { autoCreateRoomForProject } from './autoRoom.js';
import { PI_AGENT_CONSENT_DISCLOSURE, PI_AGENT_CONSENT_HEADLINE } from './consentCopy.js';
import {
  PI_AGENT_DISPLAY_NAME,
  PI_AGENT_HOOK_EVENTS,
  PI_AGENT_PROVIDER_ID,
  PI_AGENT_TOOL_NAMES,
} from './constants.js';
import { PiAgentWatcher } from './piAgentWatcher.js';

// ── State ────────────────────────────────────────────────────

let agentWatcher: PiAgentWatcher | null = null;

// ── normalizeHookEvent ───────────────────────────────────────

function normalizeHookEvent(
  raw: Record<string, unknown>,
): { sessionId: string; event: AgentEvent } | null {
  const eventName = raw.hook_event_name;
  const sessionId = raw.session_id;
  if (typeof eventName !== 'string' || typeof sessionId !== 'string') return null;

  switch (eventName) {
    case PI_AGENT_HOOK_EVENTS.SESSION_START:
      return {
        sessionId,
        event: {
          kind: 'sessionStart',
          source: typeof raw.source === 'string' ? raw.source : undefined,
          cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
        },
      };

    case PI_AGENT_HOOK_EVENTS.SESSION_END:
      return {
        sessionId,
        event: {
          kind: 'sessionEnd',
          reason: typeof raw.reason === 'string' ? raw.reason : undefined,
        },
      };

    case PI_AGENT_HOOK_EVENTS.TOOL_START: {
      const toolName =
        typeof raw.tool_name === 'string' ? raw.tool_name : PI_AGENT_TOOL_NAMES.DEFAULT;
      const toolId = typeof raw.tool_id === 'string' ? raw.tool_id : `pi-tool-${Date.now()}`;
      const toolInput =
        typeof raw.tool_input === 'object' && raw.tool_input !== null
          ? (raw.tool_input as Record<string, unknown>)
          : {};
      return {
        sessionId,
        event: { kind: 'toolStart', toolId, toolName, input: toolInput },
      };
    }

    case PI_AGENT_HOOK_EVENTS.TOOL_END:
      return {
        sessionId,
        event: { kind: 'toolEnd', toolId: 'current' },
      };

    case PI_AGENT_HOOK_EVENTS.BLOCKED:
      return {
        sessionId,
        event: { kind: 'permissionRequest' },
      };

    default:
      return null;
  }
}

// ── formatToolStatus ─────────────────────────────────────────

function formatToolStatus(_toolName: string, input?: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  const desc = typeof inp.description === 'string' && inp.description.length > 0 ? inp.description : '';
  // Truncate long descriptions for display
  if (desc.length > 50) return desc.slice(0, 47) + '\u2026';
  return desc || 'Working';
}

// ── Installer wrappers ───────────────────────────────────────

async function installHooks(serverUrl: string, authToken: string): Promise<void> {
  if (agentWatcher) {
    agentWatcher.stop();
  }

  agentWatcher = new PiAgentWatcher({
    serverUrl,
    authToken,
    onNewProject: (projectDir) => autoCreateRoomForProject(projectDir),
  });
  agentWatcher.start();
  console.log('[Pixel Agents] pi-agent: hooks installed, herdr watcher started');
}

async function uninstallHooks(): Promise<void> {
  if (agentWatcher) {
    agentWatcher.stop();
    agentWatcher = null;
    console.log('[Pixel Agents] pi-agent: hooks uninstalled');
  }
}

function areHooksInstalled(): Promise<boolean> {
  return Promise.resolve(agentWatcher?.isRunning() ?? false);
}

function consentDisclosure(): { headline: string; disclosure: string } {
  return {
    headline: PI_AGENT_CONSENT_HEADLINE,
    disclosure: PI_AGENT_CONSENT_DISCLOSURE,
  };
}

// ── The provider ─────────────────────────────────────────────

export const piAgentProvider: HookProvider = {
  kind: 'hook',
  id: PI_AGENT_PROVIDER_ID,
  displayName: PI_AGENT_DISPLAY_NAME,
  protocolVersion: 1,

  normalizeHookEvent,

  installHooks,
  uninstallHooks,
  areHooksInstalled,
  consentDisclosure,

  formatToolStatus,
  permissionExemptTools: new Set(),
  subagentToolNames: new Set(),
  readingTools: new Set(),
  // No terminal integration — Pi agents are managed by herdr
  terminalNamePrefix: undefined,
};
