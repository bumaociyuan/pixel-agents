import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createProjectScope } from '../../core/src/projectScope.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { createHttpServer, type HttpServerHandle } from '../src/httpServer.js';
import { piCrewProvider } from '../src/providers/hook/pi-crew/piCrew.js';
import { PiCrewCheckpointStore } from '../src/providers/hook/pi-crew/piCrewCheckpointStore.js';
import { PiCrewEventWatcher } from '../src/providers/hook/pi-crew/piCrewFeedWatcher.js';

describe('pi-crew watcher integration', () => {
  let tempDir: string | undefined;
  let watcher: PiCrewEventWatcher | undefined;
  let runtime: AgentRuntime | undefined;
  let server: HttpServerHandle | undefined;

  afterEach(async () => {
    await watcher?.stop();
    await server?.app.close();
    runtime?.dispose();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('delivers one JSONL run through HTTP into the agent store and leaves no orphan agents', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-crew-integration-'));
    const projectDir = path.join(tempDir, 'project');
    const runId = 'run-1';
    const eventsPath = path.join(projectDir, '.crew', 'state', 'runs', runId, 'events.jsonl');
    fs.mkdirSync(path.dirname(eventsPath), { recursive: true });

    const store = new AgentStateStore();
    runtime = new AgentRuntime(store, [piCrewProvider]);
    server = await createHttpServer({
      embedded: true,
      host: '127.0.0.1',
      port: 0,
      token: 'integration-token',
      store,
      runtime,
      onHookEvent: (providerId, event) => runtime?.handleHookEvent(providerId, event),
    });
    const scope = createProjectScope(projectDir);
    watcher = new PiCrewEventWatcher({
      projectScopes: [scope],
      serverUrl: `http://127.0.0.1:${server.port}`,
      authToken: 'integration-token',
      checkpointStore: new PiCrewCheckpointStore({
        rootDir: path.join(tempDir, 'pixel-agents-state'),
      }),
    });

    appendEvents(eventsPath, [
      { time: '2026-08-22T00:00:00.000Z', type: 'run.created', runId },
      {
        time: '2026-08-22T00:00:01.000Z',
        type: 'task.started',
        runId,
        taskId: 'implement',
        data: { agent: 'Worker', role: 'implementer', description: 'Implement feature' },
      },
    ]);
    watcher.start();
    await watcher.waitForIdle();

    expect(store.size).toBe(2);
    expect([...store.values()].map((agent) => agent.projectKey)).toEqual([scope.key, scope.key]);

    appendEvents(eventsPath, [
      {
        time: '2026-08-22T00:00:02.000Z',
        type: 'task.needs_attention',
        runId,
        taskId: 'implement',
        message: 'Need a decision',
      },
    ]);
    await waitFor(() => [...store.values()].some((agent) => agent.permissionSent));

    appendEvents(eventsPath, [
      {
        time: '2026-08-22T00:00:03.000Z',
        type: 'task.progress',
        runId,
        taskId: 'implement',
        metadata: { seq: 3 },
      },
      {
        time: '2026-08-22T00:00:04.000Z',
        type: 'task.completed',
        runId,
        taskId: 'implement',
      },
      { time: '2026-08-22T00:00:05.000Z', type: 'run.completed', runId },
    ]);
    await waitFor(() => store.size === 0);

    await watcher.stop();
    watcher = undefined;
  });

  it('keeps terminal history checkpointed across a watcher restart without replaying agents', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-crew-integration-'));
    const projectDir = path.join(tempDir, 'project');
    const runId = 'completed-run';
    const eventsPath = path.join(projectDir, '.crew', 'state', 'runs', runId, 'events.jsonl');
    fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
    appendEvents(eventsPath, [
      { time: '2026-08-22T00:00:00.000Z', type: 'run.created', runId },
      { time: '2026-08-22T00:00:01.000Z', type: 'run.completed', runId },
    ]);

    const store = new AgentStateStore();
    runtime = new AgentRuntime(store, [piCrewProvider]);
    server = await createHttpServer({
      embedded: true,
      host: '127.0.0.1',
      port: 0,
      token: 'integration-token',
      store,
      runtime,
      onHookEvent: (providerId, event) => runtime?.handleHookEvent(providerId, event),
    });
    const checkpointStore = new PiCrewCheckpointStore({
      rootDir: path.join(tempDir, 'pixel-agents-state'),
    });
    const options = {
      projectScopes: [createProjectScope(projectDir)],
      serverUrl: `http://127.0.0.1:${server.port}`,
      authToken: 'integration-token',
      checkpointStore,
    };

    watcher = new PiCrewEventWatcher(options);
    watcher.start();
    await watcher.waitForIdle();
    expect(store.size).toBe(0);
    expect(checkpointStore.load(createProjectScope(projectDir).key, runId)?.committedOffset).toBe(
      fs.statSync(eventsPath).size,
    );
    await watcher.stop();

    watcher = new PiCrewEventWatcher(options);
    watcher.start();
    await watcher.waitForIdle();
    expect(store.size).toBe(0);
  });
});

function appendEvents(eventsPath: string, events: readonly Record<string, unknown>[]): void {
  fs.appendFileSync(eventsPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for integration state');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
