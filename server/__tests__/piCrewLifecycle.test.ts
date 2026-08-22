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
    runId: 'event-run-id',
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
    runId: 'event-run-id',
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
    runId: 'event-run-id',
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
    const a = applyPiCrewEvent(
      createRunLifecycle(createProjectScope('/a/app'), 'r1', '/a/app'),
      taskStarted('t1', 'RedMoon'),
    );
    const b = applyPiCrewEvent(
      createRunLifecycle(createProjectScope('/b/app'), 'r1', '/b/app'),
      taskStarted('t1', 'RedMoon'),
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
});
