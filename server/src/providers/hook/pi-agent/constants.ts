/** pi agent provider constants. */

/** Provider id used in the registry and hook endpoint. */
export const PI_AGENT_PROVIDER_ID = 'pi-agent';

/** Display name shown in the UI. */
export const PI_AGENT_DISPLAY_NAME = 'Pi Agent';

/** Poll interval (ms) for the herdr API snapshot watcher. Pi agents
 *  change status less frequently than Claude tool calls, so 3 s is fine. */
export const PI_AGENT_POLL_MS = 3000;

/** Hook event names used in the raw event payloads POSTed to the hook endpoint. */
export const PI_AGENT_HOOK_EVENTS = {
  SESSION_START: 'PiSessionStart',
  SESSION_END: 'PiSessionEnd',
  TOOL_START: 'PiToolStart',
  TOOL_END: 'PiToolEnd',
  TURN_END: 'PiTurnEnd',
  BLOCKED: 'PiBlocked',
} as const;

/** Tool names reported to the office for Pi agent activities. */
export const PI_AGENT_TOOL_NAMES = {
  DEFAULT: 'PiAgent',
} as const;

/** Auto-room area colours — muted, non-distracting. */
/* eslint-disable pixel-agents/no-inline-colors */
export const AUTO_ROOM_COLORS = [
  '#4a6fa5',
  '#8b7355',
  '#6b8b6b',
  '#7b6b8b',
  '#a05252',
  '#6b8b7b',
  '#8b7b5b',
  '#5b7b8b',
];
/* eslint-enable pixel-agents/no-inline-colors */
