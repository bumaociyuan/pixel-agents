import { describe, expect, it } from 'vitest';

import { piAgentProvider } from '../src/providers/hook/pi-agent/piAgent.js';

describe('piAgentProvider', () => {
  describe('identity', () => {
    it('has kind "hook"', () => {
      expect(piAgentProvider.kind).toBe('hook');
    });
    it('has id "pi-agent"', () => {
      expect(piAgentProvider.id).toBe('pi-agent');
    });
    it('has a displayName', () => {
      expect(piAgentProvider.displayName).toBe('Pi Agent');
    });
    it('has protocolVersion 1', () => {
      expect(piAgentProvider.protocolVersion).toBe(1);
    });
  });

  describe('normalizeHookEvent', () => {
    it('returns null when hook_event_name is missing', () => {
      expect(piAgentProvider.normalizeHookEvent({ session_id: 'x' })).toBeNull();
    });
    it('returns null when session_id is missing', () => {
      expect(piAgentProvider.normalizeHookEvent({ hook_event_name: 'PiSessionStart' })).toBeNull();
    });
    it('returns null for unknown hook event names', () => {
      expect(
        piAgentProvider.normalizeHookEvent({
          hook_event_name: 'SomethingWeird',
          session_id: 'x',
        }),
      ).toBeNull();
    });

    it('normalizes PiSessionStart with sessionId and source', () => {
      const result = piAgentProvider.normalizeHookEvent({
        hook_event_name: 'PiSessionStart',
        session_id: 'sess-1',
        source: 'herdr',
        cwd: '/projects/test',
      });
      expect(result?.sessionId).toBe('sess-1');
      expect(result?.event.kind).toBe('sessionStart');
      if (result?.event.kind === 'sessionStart') {
        expect(result.event.source).toBe('herdr');
        expect(result.event.cwd).toBe('/projects/test');
      }
    });

    it('normalizes PiSessionEnd with reason', () => {
      const result = piAgentProvider.normalizeHookEvent({
        hook_event_name: 'PiSessionEnd',
        session_id: 'sess-1',
        reason: 'disappeared',
      });
      expect(result?.sessionId).toBe('sess-1');
      expect(result?.event.kind).toBe('sessionEnd');
      if (result?.event.kind === 'sessionEnd') {
        expect(result.event.reason).toBe('disappeared');
      }
    });

    it('normalizes PiToolStart with tool_id and tool_input', () => {
      const result = piAgentProvider.normalizeHookEvent({
        hook_event_name: 'PiToolStart',
        session_id: 'sess-1',
        tool_name: 'PiAgent',
        tool_id: 'pi-abc-123456',
        tool_input: { description: 'Working on feature X' },
      });
      expect(result?.sessionId).toBe('sess-1');
      expect(result?.event.kind).toBe('toolStart');
      if (result?.event.kind === 'toolStart') {
        expect(result.event.toolName).toBe('PiAgent');
        expect(result.event.toolId).toBe('pi-abc-123456');
        expect(result.event.input).toEqual({ description: 'Working on feature X' });
      }
    });

    it('normalizes PiToolEnd', () => {
      const result = piAgentProvider.normalizeHookEvent({
        hook_event_name: 'PiToolEnd',
        session_id: 'sess-1',
      });
      expect(result?.sessionId).toBe('sess-1');
      expect(result?.event.kind).toBe('toolEnd');
    });

    it('normalizes PiTurnEnd', () => {
      const result = piAgentProvider.normalizeHookEvent({
        hook_event_name: 'PiTurnEnd',
        session_id: 'sess-1',
      });
      expect(result?.sessionId).toBe('sess-1');
      expect(result?.event.kind).toBe('turnEnd');
    });

    it('normalizes PiBlocked as permissionRequest', () => {
      const result = piAgentProvider.normalizeHookEvent({
        hook_event_name: 'PiBlocked',
        session_id: 'sess-1',
      });
      expect(result?.sessionId).toBe('sess-1');
      expect(result?.event.kind).toBe('permissionRequest');
    });

    // ── preferred_area ───────────────────────────────────────

    it('passes preferred_area in PiSessionStart when present', () => {
      const result = piAgentProvider.normalizeHookEvent({
        hook_event_name: 'PiSessionStart',
        session_id: 'sess-1',
        source: 'herdr',
        cwd: '/projects/frontend',
        preferred_area: 'frontend',
      });
      expect(result?.sessionId).toBe('sess-1');
      expect(result?.event.kind).toBe('sessionStart');
      if (result?.event.kind === 'sessionStart') {
        expect(result.event.preferredArea).toBe('frontend');
      }
    });

    it('omits preferredArea when preferred_area is not a string', () => {
      const result = piAgentProvider.normalizeHookEvent({
        hook_event_name: 'PiSessionStart',
        session_id: 'sess-1',
        source: 'herdr',
        cwd: '/projects/frontend',
        preferred_area: 42,
      });
      expect(result?.sessionId).toBe('sess-1');
      expect(result?.event.kind).toBe('sessionStart');
      if (result?.event.kind === 'sessionStart') {
        expect(result.event.preferredArea).toBeUndefined();
      }
    });
  });
});