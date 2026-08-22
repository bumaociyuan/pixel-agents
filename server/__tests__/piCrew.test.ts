import { describe, expect, it } from 'vitest';

import { piCrewProvider } from '../src/providers/hook/pi-crew/piCrew.js';

describe('piCrewProvider', () => {
  describe('identity', () => {
    it('has kind "hook"', () => {
      expect(piCrewProvider.kind).toBe('hook');
    });
    it('has id "pi-crew"', () => {
      expect(piCrewProvider.id).toBe('pi-crew');
    });
    it('has a displayName', () => {
      expect(piCrewProvider.displayName).toBe('pi-crew');
    });
    it('has protocolVersion 1', () => {
      expect(piCrewProvider.protocolVersion).toBe(1);
    });
  });

  describe('normalizeHookEvent', () => {
    it('returns null when hook_event_name is missing', () => {
      expect(piCrewProvider.normalizeHookEvent({ session_id: 'x' })).toBeNull();
    });
    it('returns null when session_id is missing', () => {
      expect(piCrewProvider.normalizeHookEvent({ hook_event_name: 'CrewSessionStart' })).toBeNull();
    });
    it('returns null for unknown hook event names', () => {
      expect(
        piCrewProvider.normalizeHookEvent({
          hook_event_name: 'SomethingWeird',
          session_id: 'x',
        }),
      ).toBeNull();
    });

    it('normalizes CrewSessionStart with sessionId, source, and cwd', () => {
      const result = piCrewProvider.normalizeHookEvent({
        hook_event_name: 'CrewSessionStart',
        session_id: 'crew-sess-1',
        source: 'task.started',
        cwd: '/projects/test',
        agent_name: 'worker-1',
      });
      expect(result?.sessionId).toBe('crew-sess-1');
      expect(result?.event.kind).toBe('sessionStart');
      if (result?.event.kind === 'sessionStart') {
        expect(result.event.source).toBe('task.started');
        expect(result.event.cwd).toBe('/projects/test');
      }
    });

    it('normalizes CrewSessionEnd with reason', () => {
      const result = piCrewProvider.normalizeHookEvent({
        hook_event_name: 'CrewSessionEnd',
        session_id: 'crew-sess-1',
        reason: 'task.completed',
      });
      expect(result?.sessionId).toBe('crew-sess-1');
      expect(result?.event.kind).toBe('sessionEnd');
      if (result?.event.kind === 'sessionEnd') {
        expect(result.event.reason).toBe('task.completed');
      }
    });

    it('normalizes CrewTaskStart with tool_id and tool_input', () => {
      const result = piCrewProvider.normalizeHookEvent({
        hook_event_name: 'CrewTaskStart',
        session_id: 'crew-sess-1',
        tool_name: 'CrewTask',
        tool_id: 'crew-task-t1',
        tool_input: { description: 'Implement feature', task_id: 't1', role: 'worker' },
      });
      expect(result?.sessionId).toBe('crew-sess-1');
      expect(result?.event.kind).toBe('toolStart');
      if (result?.event.kind === 'toolStart') {
        expect(result.event.toolName).toBe('CrewTask');
        expect(result.event.toolId).toBe('crew-task-t1');
        expect(result.event.input).toEqual({
          description: 'Implement feature',
          task_id: 't1',
          role: 'worker',
        });
      }
    });

    it('normalizes CrewTaskDone', () => {
      const result = piCrewProvider.normalizeHookEvent({
        hook_event_name: 'CrewTaskDone',
        session_id: 'crew-sess-1',
        tool_id: 'crew-task-t1',
      });
      expect(result?.sessionId).toBe('crew-sess-1');
      expect(result?.event.kind).toBe('toolEnd');
    });

    it('normalizes CrewTaskBlock as permissionRequest', () => {
      const result = piCrewProvider.normalizeHookEvent({
        hook_event_name: 'CrewTaskBlock',
        session_id: 'crew-sess-1',
      });
      expect(result?.sessionId).toBe('crew-sess-1');
      expect(result?.event.kind).toBe('permissionRequest');
    });

    it('normalizes CrewPlanStart', () => {
      const result = piCrewProvider.normalizeHookEvent({
        hook_event_name: 'CrewPlanStart',
        session_id: 'crew-sess-1',
        tool_id: 'crew-plan-r1',
        tool_input: { description: 'Planning', runId: 'r1' },
      });
      expect(result?.sessionId).toBe('crew-sess-1');
      expect(result?.event.kind).toBe('toolStart');
      if (result?.event.kind === 'toolStart') {
        expect(result.event.toolName).toBe('CrewPlan');
      }
    });

    it('normalizes CrewPlanDone', () => {
      const result = piCrewProvider.normalizeHookEvent({
        hook_event_name: 'CrewPlanDone',
        session_id: 'crew-sess-1',
        tool_id: 'crew-plan-r1',
      });
      expect(result?.sessionId).toBe('crew-sess-1');
      expect(result?.event.kind).toBe('toolEnd');
    });

    // ── preferredArea ───────────────────────────────────────

    it('passes preferredArea in CrewSessionStart when present', () => {
      const result = piCrewProvider.normalizeHookEvent({
        hook_event_name: 'CrewSessionStart',
        session_id: 'crew-sess-1',
        source: 'task.started',
        cwd: '/projects/frontend',
        preferred_area: 'frontend',
      });
      expect(result?.sessionId).toBe('crew-sess-1');
      expect(result?.event.kind).toBe('sessionStart');
      if (result?.event.kind === 'sessionStart') {
        expect(result.event.preferredArea).toBe('frontend');
      }
    });

    it('omits preferredArea when preferred_area is not a string', () => {
      const result = piCrewProvider.normalizeHookEvent({
        hook_event_name: 'CrewSessionStart',
        session_id: 'crew-sess-1',
        source: 'task.started',
        cwd: '/projects/frontend',
        preferred_area: 42,
      });
      expect(result?.sessionId).toBe('crew-sess-1');
      expect(result?.event.kind).toBe('sessionStart');
      if (result?.event.kind === 'sessionStart') {
        expect(result.event.preferredArea).toBeUndefined();
      }
    });
  });

  describe('formatToolStatus', () => {
    it('formats CrewTask with description', () => {
      const status = piCrewProvider.formatToolStatus('CrewTask', {
        description: 'Build login page',
        role: 'worker',
      });
      expect(status).toBe('pi-crew: Build login page [worker]');
    });

    it('formats CrewTask without description', () => {
      const status = piCrewProvider.formatToolStatus('CrewTask', {});
      expect(status).toBe('Working on pi-crew task');
    });

    it('formats CrewPlan', () => {
      const status = piCrewProvider.formatToolStatus('CrewPlan');
      expect(status).toBe('Planning pi-crew tasks');
    });

    it('formats CrewReview', () => {
      const status = piCrewProvider.formatToolStatus('CrewReview');
      expect(status).toBe('Reviewing pi-crew task');
    });
  });
});
