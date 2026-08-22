import { describe, expect, it } from 'vitest';

import { createProjectScope } from '../../core/src/projectScope.js';
import {
  applyPiCrewEvent,
  createRunLifecycle,
} from '../src/providers/hook/pi-crew/piCrewLifecycle.js';

function taskStarted(
  taskId: string,
  agent: string,
  attemptId?: string,
): {
  time: string;
  type: 'task.started';
  runId: string;
  taskId: string;
  message: string;
  data: { agent: string; role: string };
  metadata?: { attemptId: string };
} {
  return {
    time: '2026-08-22T00:00:00.000Z',
    type: 'task.started',
    runId: 'run-1',
    taskId,
    message: `Work on ${taskId}`,
    data: { agent, role: 'worker' },
    metadata: attemptId ? { attemptId } : undefined,
  };
}

function taskCompleted(taskId: string): {
  time: string;
  type: 'task.completed';
  runId: string;
  taskId: string;
} {
  return {
    time: '2026-08-22T00:00:00.000Z',
    type: 'task.completed',
    runId: 'run-1',
    taskId,
  };
}

function lifecycleEvent(
  type: string,
  taskId?: string,
  data?: Record<string, unknown>,
): {
  time: string;
  type: string;
  runId: string;
  taskId?: string;
  data?: Record<string, unknown>;
} {
  return {
    time: '2026-08-22T00:00:00.000Z',
    type,
    runId: 'run-1',
    taskId,
    data,
  };
}

function run() {
  return createRunLifecycle(createProjectScope('/a/app'), 'run-1', '/a/app');
}

function eventName(payload: Record<string, unknown>): unknown {
  return payload.hook_event_name;
}

function isSessionEnd(payload: Record<string, unknown>): boolean {
  return payload.hook_event_name === 'CrewSessionEnd';
}

describe('pi-crew lifecycle', () => {
  it('introduces an agent before starting its first task', () => {
    const state = createRunLifecycle(createProjectScope('/a/app'), 'run-1', '/a/app');

    const payloads = applyPiCrewEvent(state, taskStarted('t1', 'RedMoon'));

    expect(payloads.map((payload) => payload.hook_event_name)).toEqual([
      'CrewSessionStart',
      'CrewTaskStart',
    ]);
  });

  it('namespaces equal agent names by project and run', () => {
    const event = taskStarted('t1', 'RedMoon');
    event.runId = 'r1';
    const a = applyPiCrewEvent(
      createRunLifecycle(createProjectScope('/a/app'), 'r1', '/a/app'),
      event,
    );
    const otherProjectEvent = taskStarted('t1', 'RedMoon');
    otherProjectEvent.runId = 'r1';
    const b = applyPiCrewEvent(
      createRunLifecycle(createProjectScope('/b/app'), 'r1', '/b/app'),
      otherProjectEvent,
    );

    expect(a[0].session_id).not.toBe(b[0].session_id);
  });

  it('keeps a session until its final active task ends', () => {
    const state = run();
    applyPiCrewEvent(state, taskStarted('t1', 'A'));
    applyPiCrewEvent(state, taskStarted('t2', 'A'));

    expect(applyPiCrewEvent(state, taskCompleted('t1')).some(isSessionEnd)).toBe(false);
    expect(applyPiCrewEvent(state, taskCompleted('t2')).some(isSessionEnd)).toBe(true);
  });

  it('releases the old owner when a task is reassigned', () => {
    const state = run();
    applyPiCrewEvent(state, taskStarted('t1', 'A'));

    const payloads = applyPiCrewEvent(state, taskStarted('t1', 'B', 'attempt-2'));

    expect(payloads.map(eventName)).toEqual([
      'CrewTaskDone',
      'CrewSessionEnd',
      'CrewSessionStart',
      'CrewTaskStart',
    ]);
  });

  it('unblocks an attention task before reporting progress', () => {
    const state = run();
    applyPiCrewEvent(state, taskStarted('t1', 'A'));

    expect(
      applyPiCrewEvent(state, lifecycleEvent('task.needs_attention', 't1')).map(eventName),
    ).toEqual(['CrewTaskBlock']);
    expect(applyPiCrewEvent(state, lifecycleEvent('task.progress', 't1')).map(eventName)).toEqual([
      'CrewTaskUnblock',
      'CrewProgress',
    ]);
  });

  it('finishes a failed task without requesting permission', () => {
    const state = run();
    applyPiCrewEvent(state, taskStarted('t1', 'A'));

    expect(applyPiCrewEvent(state, lifecycleEvent('task.failed', 't1')).map(eventName)).toEqual([
      'CrewTaskDone',
      'CrewSessionEnd',
    ]);
  });

  it('cleans up an active task when its worker exits abnormally', () => {
    const state = run();
    applyPiCrewEvent(state, taskStarted('t1', 'A'));

    expect(
      applyPiCrewEvent(state, lifecycleEvent('worker.hard_kill', 't1')).map(eventName),
    ).toEqual(['CrewTaskDone', 'CrewSessionEnd']);
  });

  it('closes every active task when the run terminates', () => {
    const state = run();
    applyPiCrewEvent(state, taskStarted('t1', 'A'));
    applyPiCrewEvent(state, taskStarted('t2', 'B'));

    expect(applyPiCrewEvent(state, lifecycleEvent('run.completed')).map(eventName)).toEqual([
      'CrewTaskDone',
      'CrewSessionEnd',
      'CrewTaskDone',
      'CrewSessionEnd',
    ]);
  });

  it('does not emit duplicate lifecycle events for replayed events', () => {
    const state = run();
    const started = taskStarted('t1', 'A', 'attempt-1');

    applyPiCrewEvent(state, started);
    expect(applyPiCrewEvent(state, started)).toEqual([]);
    applyPiCrewEvent(state, taskCompleted('t1'));
    expect(applyPiCrewEvent(state, taskCompleted('t1'))).toEqual([]);
  });

  it('uses the worker id before the role fallback', () => {
    const state = run();

    const payloads = applyPiCrewEvent(
      state,
      lifecycleEvent('task.started', 't1', { workerId: 'worker-9', role: 'reviewer' }),
    );

    expect(payloads[0].agent_name).toBe('worker-9');
  });

  it('uses snake-case worker id before the role fallback', () => {
    const payloads = applyPiCrewEvent(
      run(),
      lifecycleEvent('task.started', 't1', { worker_id: 'worker-10', role: 'reviewer' }),
    );

    expect(payloads[0].agent_name).toBe('worker-10');
  });

  it('starts and ends the planner for a run', () => {
    const state = run();

    expect(applyPiCrewEvent(state, lifecycleEvent('run.created')).map(eventName)).toEqual([
      'CrewSessionStart',
      'CrewPlanStart',
    ]);
    expect(applyPiCrewEvent(state, lifecycleEvent('run.completed')).map(eventName)).toEqual([
      'CrewPlanDone',
      'CrewSessionEnd',
    ]);
  });

  it.each(['worker.hard_kill', 'worker.failed', 'worker.terminated'])(
    'cleans every active and prepared task when %s includes a task id',
    (type) => {
      const state = run();
      applyPiCrewEvent(state, taskStarted('t1', 'A'));
      applyPiCrewEvent(state, taskStarted('t2', 'A'));
      applyPiCrewEvent(
        state,
        lifecycleEvent('task.parallel_start', undefined, {
          taskIds: ['t3'],
          roles: ['worker'],
          agents: ['A'],
        }),
      );

      const payloads = applyPiCrewEvent(state, lifecycleEvent(type, 't1'));

      expect(payloads.map(eventName)).toEqual(['CrewTaskDone', 'CrewTaskDone', 'CrewSessionEnd']);
      expect(payloads.filter(isSessionEnd)).toHaveLength(1);
      expect([...state.tasks.values()].every((task) => !task.active && !task.prepared)).toBe(true);
    },
  );

  it('closes a prepared worker session when its task is cancelled', () => {
    const state = run();
    applyPiCrewEvent(
      state,
      lifecycleEvent('task.parallel_start', undefined, {
        taskIds: ['t1'],
        roles: ['worker'],
        agents: ['A'],
      }),
    );

    expect(applyPiCrewEvent(state, lifecycleEvent('task.cancelled', 't1')).map(eventName)).toEqual([
      'CrewSessionEnd',
    ]);
  });

  it('cleans active and prepared sessions when a run is cancelled', () => {
    const state = run();
    applyPiCrewEvent(state, taskStarted('t1', 'A'));
    applyPiCrewEvent(
      state,
      lifecycleEvent('task.parallel_start', undefined, {
        taskIds: ['t2'],
        roles: ['worker'],
        agents: ['B'],
      }),
    );

    expect(applyPiCrewEvent(state, lifecycleEvent('run.cancelled')).map(eventName)).toEqual([
      'CrewTaskDone',
      'CrewSessionEnd',
      'CrewSessionEnd',
    ]);
    expect(state.terminal).toBe(true);
  });

  it('starts a new attempt with a distinct tool id', () => {
    const state = run();
    const first = applyPiCrewEvent(state, taskStarted('t1', 'A', 'attempt-1'));
    const retry = applyPiCrewEvent(state, taskStarted('t1', 'A', 'attempt-2'));

    expect(first[1].tool_id).toContain('attempt-1');
    expect(retry.map(eventName)).toEqual(['CrewTaskDone', 'CrewTaskStart']);
    expect(retry[1].tool_id).toContain('attempt-2');
    expect(retry[1].tool_id).not.toBe(first[1].tool_id);
  });

  it('uses the reserved planner identity instead of a worker-like name', () => {
    const state = run();
    const planner = applyPiCrewEvent(state, lifecycleEvent('run.created'));
    const worker = applyPiCrewEvent(state, taskStarted('t1', 'crew-planner'));

    expect(planner[0].agent_name).toBe('planner');
    expect(worker[0].session_id).not.toBe(planner[0].session_id);
  });

  it('keeps sanitization collisions in separate agent namespaces', () => {
    const state = run();
    const slash = applyPiCrewEvent(state, taskStarted('t1', 'A/B'));
    const hyphen = applyPiCrewEvent(state, taskStarted('t2', 'A-B'));

    expect(hyphen[0].hook_event_name).toBe('CrewSessionStart');
    expect(hyphen[0].session_id).not.toBe(slash[0].session_id);
  });

  it('returns a diagnostic without mutating state for another run event', () => {
    const state = run();
    const otherRunEvent = taskStarted('t1', 'A');
    otherRunEvent.runId = 'other-run';

    expect(applyPiCrewEvent(state, otherRunEvent)).toEqual([
      {
        hook_event_name: 'CrewDiagnostic',
        reason: 'run_id_mismatch',
        event_run_id: 'other-run',
        state_run_id: 'run-1',
      },
    ]);
    expect(state.agents).toHaveLength(0);
  });
});
