import { createHash } from 'node:crypto';

import type { ProjectScope } from '../../../../../core/src/projectScope.js';
import { PI_CREW_HOOK_EVENTS, PI_CREW_TOOL_NAMES } from './constants.js';
import type { PiCrewEvent } from './feedTypes.js';

export type HookPayload = Record<string, unknown>;

export interface AgentLifecycleState {
  key: string;
  name: string;
  sessionId: string;
  activeTaskIds: Set<string>;
  introduced: boolean;
  sessionOpen: boolean;
}

export interface TaskLifecycleState {
  id: string;
  agentKey: string;
  role: string;
  toolId: string;
  active: boolean;
  blocked: boolean;
  prepared: boolean;
  attemptId?: string;
}

export interface RunLifecycleState {
  project: ProjectScope;
  runId: string;
  cwd: string;
  agents: Map<string, AgentLifecycleState>;
  tasks: Map<string, TaskLifecycleState>;
  planner?: { agentKey: string; toolId: string; active: boolean };
  terminal: boolean;
}

export function createRunLifecycle(
  project: ProjectScope,
  runId: string,
  cwd: string,
): RunLifecycleState {
  return {
    project,
    runId,
    cwd,
    agents: new Map(),
    tasks: new Map(),
    terminal: false,
  };
}

export function applyPiCrewEvent(state: RunLifecycleState, event: PiCrewEvent): HookPayload[] {
  if (event.runId !== state.runId) {
    return [
      {
        hook_event_name: 'CrewDiagnostic',
        reason: 'run_id_mismatch',
        event_run_id: event.runId,
        state_run_id: state.runId,
      },
    ];
  }
  if (state.terminal) return [];

  switch (event.type) {
    case 'run.created':
      return startPlanner(state, event);
    case 'run.completed':
    case 'run.failed':
    case 'run.cancelled':
      return finishRun(state, event.type);
    case 'task.started':
      return startTask(state, event);
    case 'task.completed':
      return finishTaskById(state, event.taskId, 'task.completed');
    case 'task.failed':
      return finishTaskById(state, event.taskId, 'task.failed');
    case 'task.cancelled':
      return finishTaskById(state, event.taskId, 'task.cancelled');
    case 'task.needs_attention':
    case 'task.attention':
      return blockTask(state, event);
    case 'task.progress':
      return reportProgress(state, event);
    case 'task.parallel_start':
      return prepareParallelTasks(state, event);
    case 'worker.exit':
    case 'worker.close':
    case 'worker.cancelled':
    case 'worker.spawn_error':
    case 'worker.response_timeout':
    case 'worker.final_drain':
    case 'worker.hard_kill':
    case 'worker.failed':
    case 'worker.terminated':
      return cleanUpWorker(state, event);
    default:
      return [];
  }
}

function startPlanner(state: RunLifecycleState, event: PiCrewEvent): HookPayload[] {
  if (state.planner?.active) return [];

  const planner = getAgent(state, 'planner');
  state.planner = {
    agentKey: planner.key,
    toolId: `crew-plan:${state.project.key}:${sanitizeKey(state.runId)}`,
    active: true,
  };

  const payloads = introduceAgent(planner, {
    source: 'run.created',
    cwd: state.cwd,
    role: 'planner',
    runId: state.runId,
  });
  payloads.push({
    hook_event_name: PI_CREW_HOOK_EVENTS.PLAN_START,
    session_id: planner.sessionId,
    agent_name: planner.name,
    tool_name: PI_CREW_TOOL_NAMES.PLAN,
    tool_id: state.planner.toolId,
    tool_input: {
      description: event.message || 'Planning pi-crew run',
      runId: state.runId,
    },
  });
  return payloads;
}

function startTask(state: RunLifecycleState, event: PiCrewEvent): HookPayload[] {
  const taskId = event.taskId || 'unknown';
  const role = stringValue(event.data?.role) || 'worker';
  const agentName =
    stringValue(event.data?.agent) ||
    stringValue(event.data?.workerId) ||
    stringValue(event.data?.worker_id) ||
    `${role}:${taskId}`;
  const agent = getAgent(state, agentName);
  const task = state.tasks.get(taskId);
  const attemptId = event.metadata?.attemptId || 'default';

  if (task?.active && task.agentKey === agent.key && task.attemptId === attemptId) return [];
  if (task && !task.active && !task.prepared && task.attemptId === attemptId) {
    return [];
  }

  const payloads: HookPayload[] = [];
  if (task?.active) {
    payloads.push(
      ...finishTask(
        state,
        task,
        task.agentKey === agent.key ? 'task.retry' : 'task.reassigned',
        task.agentKey !== agent.key,
      ),
    );
  }
  payloads.push(
    ...introduceAgent(agent, {
      source: 'task.started',
      cwd: stringValue(event.data?.cwd) || state.cwd,
      role,
      taskId,
      runId: state.runId,
    }),
  );

  const nextTask: TaskLifecycleState = {
    id: taskId,
    agentKey: agent.key,
    role,
    toolId: taskToolId(state, agent, taskId, attemptId),
    active: true,
    blocked: false,
    prepared: false,
    attemptId,
  };
  state.tasks.set(taskId, nextTask);
  agent.activeTaskIds.add(taskId);

  payloads.push({
    hook_event_name: PI_CREW_HOOK_EVENTS.TASK_START,
    session_id: agent.sessionId,
    agent_name: agent.name,
    tool_name: roleToToolName(role),
    tool_id: nextTask.toolId,
    tool_input: {
      task_id: taskId,
      description: event.message || stringValue(event.data?.description) || `Task ${taskId}`,
      role,
      runId: state.runId,
    },
    task_id: taskId,
    task_title: event.message || stringValue(event.data?.description) || `Task ${taskId}`,
  });

  return payloads;
}

function blockTask(state: RunLifecycleState, event: PiCrewEvent): HookPayload[] {
  const task = event.taskId ? state.tasks.get(event.taskId) : undefined;
  if (!task?.active || task.blocked) return [];

  const agent = state.agents.get(task.agentKey);
  if (!agent) return [];
  task.blocked = true;
  return [
    {
      hook_event_name: PI_CREW_HOOK_EVENTS.TASK_BLOCK,
      session_id: agent.sessionId,
      agent_name: agent.name,
      task_id: task.id,
      task_title: event.message || stringValue(event.data?.reason) || 'Needs attention',
    },
  ];
}

function reportProgress(state: RunLifecycleState, event: PiCrewEvent): HookPayload[] {
  const taskId = event.taskId || stringValue(event.data?.taskId);
  const task = taskId ? state.tasks.get(taskId) : undefined;
  if (!task?.active) return [];

  const agent = state.agents.get(task.agentKey);
  if (!agent) return [];
  const payloads: HookPayload[] = [];
  if (task.blocked) {
    task.blocked = false;
    payloads.push({
      hook_event_name: PI_CREW_HOOK_EVENTS.TASK_UNBLOCK,
      session_id: agent.sessionId,
      agent_name: agent.name,
      task_id: task.id,
    });
  }
  payloads.push({
    hook_event_name: PI_CREW_HOOK_EVENTS.PROGRESS,
    session_id: agent.sessionId,
    agent_name: agent.name,
    tool_id: task.toolId,
    data: {
      eventType: event.data?.eventType,
      activityState: event.data?.activityState,
      toolCount: event.data?.toolCount,
      turns: event.data?.turns,
      tokens: event.data?.tokens,
    },
  });
  return payloads;
}

function prepareParallelTasks(state: RunLifecycleState, event: PiCrewEvent): HookPayload[] {
  const taskIds = arrayOfStrings(event.data?.taskIds);
  const roles = arrayOfStrings(event.data?.roles);
  const agents = arrayOfStrings(event.data?.agents);
  const payloads: HookPayload[] = [];

  for (let index = 0; index < taskIds.length; index += 1) {
    const taskId = taskIds[index];
    if (state.tasks.get(taskId)?.active || state.tasks.get(taskId)?.prepared) continue;
    const role = roles[index] || 'worker';
    const agent = getAgent(state, agents[index] || `${role}:${taskId}`);
    state.tasks.set(taskId, {
      id: taskId,
      agentKey: agent.key,
      role,
      toolId: taskToolId(state, agent, taskId, 'default'),
      active: false,
      blocked: false,
      prepared: true,
    });
    payloads.push(
      ...introduceAgent(agent, {
        source: 'task.parallel_start',
        cwd: state.cwd,
        role,
        taskId,
        runId: state.runId,
      }),
    );
  }
  return payloads;
}

function finishTaskById(
  state: RunLifecycleState,
  taskId: string | undefined,
  reason: string,
): HookPayload[] {
  const task = taskId ? state.tasks.get(taskId) : undefined;
  if (task?.active) return finishTask(state, task, reason);
  return task?.prepared ? discardPreparedTask(state, task, reason) : [];
}

function finishTask(
  state: RunLifecycleState,
  task: TaskLifecycleState,
  reason: string,
  endSessionWhenIdle = true,
): HookPayload[] {
  const agent = state.agents.get(task.agentKey);
  if (!agent || !task.active) return [];

  task.active = false;
  task.blocked = false;
  task.prepared = false;
  agent.activeTaskIds.delete(task.id);
  const payloads: HookPayload[] = [
    {
      hook_event_name: PI_CREW_HOOK_EVENTS.TASK_DONE,
      session_id: agent.sessionId,
      agent_name: agent.name,
      tool_id: task.toolId,
      task_id: task.id,
    },
  ];
  if (endSessionWhenIdle && !hasLiveTasksForAgent(state, agent.key)) {
    payloads.push(endAgent(agent, reason));
  }
  return payloads;
}

function discardPreparedTask(
  state: RunLifecycleState,
  task: TaskLifecycleState,
  reason: string,
): HookPayload[] {
  const agent = state.agents.get(task.agentKey);
  if (!agent || !task.prepared) return [];

  task.prepared = false;
  return hasLiveTasksForAgent(state, agent.key) ? [] : [endAgent(agent, reason)];
}

function cleanUpWorker(state: RunLifecycleState, event: PiCrewEvent): HookPayload[] {
  const task = event.taskId ? state.tasks.get(event.taskId) : undefined;
  const agentName = explicitWorkerName(event);
  const agent = agentName
    ? state.agents.get(sanitizeKey(agentName))
    : task
      ? state.agents.get(task.agentKey)
      : state.agents.get(sanitizeKey(workerFallbackName(event)));
  if (!agent) return [];

  const payloads: HookPayload[] = [];
  for (const candidate of state.tasks.values()) {
    if (candidate.agentKey === agent.key && (candidate.active || candidate.prepared)) {
      payloads.push(...finishTaskById(state, candidate.id, event.type));
    }
  }
  return payloads;
}

function finishRun(state: RunLifecycleState, reason: string): HookPayload[] {
  const payloads: HookPayload[] = [];
  for (const task of state.tasks.values()) {
    if (task.active || task.prepared) payloads.push(...finishTaskById(state, task.id, reason));
  }
  if (state.planner?.active) {
    const planner = state.agents.get(state.planner.agentKey);
    if (planner) {
      payloads.push({
        hook_event_name: PI_CREW_HOOK_EVENTS.PLAN_DONE,
        session_id: planner.sessionId,
        agent_name: planner.name,
        tool_id: state.planner.toolId,
      });
      payloads.push(endAgent(planner, reason));
    }
    state.planner.active = false;
  }
  state.terminal = true;
  return payloads;
}

function introduceAgent(agent: AgentLifecycleState, data: Record<string, unknown>): HookPayload[] {
  if (agent.sessionOpen) return [];
  agent.introduced = true;
  agent.sessionOpen = true;
  return [
    {
      hook_event_name: PI_CREW_HOOK_EVENTS.SESSION_START,
      session_id: agent.sessionId,
      agent_name: agent.name,
      ...data,
    },
  ];
}

function endAgent(agent: AgentLifecycleState, reason: string): HookPayload {
  agent.sessionOpen = false;
  return {
    hook_event_name: PI_CREW_HOOK_EVENTS.SESSION_END,
    session_id: agent.sessionId,
    agent_name: agent.name,
    reason,
  };
}

function getAgent(state: RunLifecycleState, name: string): AgentLifecycleState {
  const key = sanitizeKey(name);
  const existing = state.agents.get(key);
  if (existing) return existing;

  const agent: AgentLifecycleState = {
    key,
    name,
    sessionId: `pi-crew:${state.project.key}:${sanitizeKey(state.runId)}:${key}`,
    activeTaskIds: new Set(),
    introduced: false,
    sessionOpen: false,
  };
  state.agents.set(key, agent);
  return agent;
}

function hasLiveTasksForAgent(state: RunLifecycleState, agentKey: string): boolean {
  return [...state.tasks.values()].some(
    (task) => task.agentKey === agentKey && (task.active || task.prepared),
  );
}

function taskToolId(
  state: RunLifecycleState,
  agent: AgentLifecycleState,
  taskId: string,
  attemptId: string,
): string {
  return `crew-task:${state.project.key}:${sanitizeKey(state.runId)}:${agent.key}:${sanitizeKey(taskId)}:${sanitizeKey(attemptId)}`;
}

function sanitizeKey(value: string): string {
  const readable =
    value
      .trim()
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unknown';
  const suffix = createHash('sha256').update(value).digest('base64url').slice(0, 8);
  return `${readable}-${suffix}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function explicitWorkerName(event: PiCrewEvent): string | undefined {
  return (
    stringValue(event.data?.agent) ||
    stringValue(event.data?.workerId) ||
    stringValue(event.data?.worker_id)
  );
}

function workerFallbackName(event: PiCrewEvent): string {
  return `${stringValue(event.data?.role) || 'worker'}:${event.taskId || 'unknown'}`;
}

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
