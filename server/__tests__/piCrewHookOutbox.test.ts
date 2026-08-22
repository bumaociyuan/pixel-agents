import * as http from 'node:http';

import { describe, expect, it } from 'vitest';

import {
  HookOutbox,
  type HookPayloadEnvelope,
  type HookRequest,
} from '../src/providers/hook/pi-crew/hookOutbox.js';

describe('HookOutbox', () => {
  it('serializes real HTTP payloads until the earlier response completes', async () => {
    const received: Array<{ name: string; idempotencyKey: string }> = [];
    const firstArrived = deferred<void>();
    const completeFirst = deferred<void>();
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
          string,
          unknown
        >;
        received.push({
          name: String(payload.hook_event_name),
          idempotencyKey: String(request.headers['x-pixel-agents-idempotency-key']),
        });
        if (received.length === 1) {
          firstArrived.resolve();
          void completeFirst.promise.then(() => response.writeHead(204).end());
          return;
        }
        response.writeHead(204).end();
      });
    });
    const serverUrl = await listen(server);
    const outbox = new HookOutbox({
      serverUrl,
      authToken: 'test-token',
      requestTimeoutMs: 1_000,
      maxAttempts: 1,
      backoffMs: () => 0,
    });

    try {
      const delivery = outbox.enqueue({
        eventId: 'http-source',
        payloads: [
          envelope('http-source', 0, 'CrewSessionStart'),
          envelope('http-source', 1, 'CrewTaskStart'),
        ],
      });

      await firstArrived.promise;
      expect(received).toEqual([{ name: 'CrewSessionStart', idempotencyKey: 'http-source:0' }]);
      completeFirst.resolve();

      await expect(delivery).resolves.toMatchObject({ outcome: 'success', attempts: 2 });
      expect(received).toEqual([
        { name: 'CrewSessionStart', idempotencyKey: 'http-source:0' },
        { name: 'CrewTaskStart', idempotencyKey: 'http-source:1' },
      ]);
    } finally {
      outbox.dispose();
      await close(server);
    }
  });

  it('waits for the earlier HTTP response body to end before sending the next payload', async () => {
    const received: string[] = [];
    const firstHeadersSent = deferred<void>();
    const endFirstBody = deferred<void>();
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
          string,
          unknown
        >;
        received.push(String(payload.hook_event_name));
        if (received.length === 1) {
          response.writeHead(200, { 'Content-Length': '1' });
          response.flushHeaders();
          firstHeadersSent.resolve();
          void endFirstBody.promise.then(() => response.end('x'));
          return;
        }
        response.writeHead(204).end();
      });
    });
    const serverUrl = await listen(server);
    const outbox = new HookOutbox({
      serverUrl,
      authToken: 'test-token',
      requestTimeoutMs: 1_000,
      maxAttempts: 1,
      backoffMs: () => 0,
    });

    try {
      const delivery = outbox.enqueue({
        eventId: 'body-source',
        payloads: [
          envelope('body-source', 0, 'CrewSessionStart'),
          envelope('body-source', 1, 'CrewTaskStart'),
        ],
      });

      await firstHeadersSent.promise;
      await nextTick();
      expect(received).toEqual(['CrewSessionStart']);

      endFirstBody.resolve();

      await expect(delivery).resolves.toMatchObject({ outcome: 'success', attempts: 2 });
      expect(received).toEqual(['CrewSessionStart', 'CrewTaskStart']);
    } finally {
      outbox.dispose();
      await close(server);
    }
  });

  it('does not send a later payload until the preceding payload has completed', async () => {
    const received: string[] = [];
    const firstRequest = deferred<void>();
    const completeFirst = deferred<{ statusCode: number }>();
    const outbox = createOutbox((request) => {
      received.push(eventName(request));
      if (received.length === 1) {
        firstRequest.resolve();
        return completeFirst.promise;
      }
      return Promise.resolve({ statusCode: 204 });
    });

    const delivery = outbox.enqueue({
      eventId: 'source-1',
      payloads: [
        envelope('source-1', 0, 'CrewSessionStart'),
        envelope('source-1', 1, 'CrewTaskStart'),
      ],
    });

    await firstRequest.promise;
    expect(received).toEqual(['CrewSessionStart']);
    completeFirst.resolve({ statusCode: 204 });

    await expect(delivery).resolves.toMatchObject({ outcome: 'success' });
    expect(received).toEqual(['CrewSessionStart', 'CrewTaskStart']);
  });

  it.each([408, 429, 500])(
    'retries HTTP %i before advancing to the next payload',
    async (status) => {
      const received: string[] = [];
      let attempts = 0;
      const outbox = createOutbox((request) => {
        received.push(eventName(request));
        attempts += 1;
        return Promise.resolve({ statusCode: attempts === 1 ? status : 204 });
      });

      await expect(
        outbox.enqueue({
          eventId: 'source-2',
          payloads: [
            envelope('source-2', 0, 'CrewSessionStart'),
            envelope('source-2', 1, 'CrewTaskStart'),
          ],
        }),
      ).resolves.toMatchObject({ outcome: 'success', attempts: 3 });

      expect(received).toEqual(['CrewSessionStart', 'CrewSessionStart', 'CrewTaskStart']);
    },
  );

  it('adds an idempotency key and retries a request that times out', async () => {
    const received: string[] = [];
    let attempts = 0;
    const outbox = createOutbox(
      (request) => {
        received.push(request.idempotencyKey);
        attempts += 1;
        if (attempts > 1) return Promise.resolve({ statusCode: 204 });
        return new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      },
      { requestTimeoutMs: 20 },
    );

    await expect(
      outbox.enqueue({ eventId: 'timeout-source', payloads: [envelope('timeout-source', 0)] }),
    ).resolves.toMatchObject({ outcome: 'success', attempts: 2 });

    expect(received).toEqual(['timeout-source:0', 'timeout-source:0']);
  });

  it('reports a 400 as permanent without retrying it forever', async () => {
    let attempts = 0;
    const diagnostics: string[] = [];
    const outbox = createOutbox(
      () => {
        attempts += 1;
        return Promise.resolve({ statusCode: 400 });
      },
      { onDiagnostic: (message) => diagnostics.push(message) },
    );

    await expect(
      outbox.enqueue({ eventId: 'permanent-source', payloads: [envelope('permanent-source', 0)] }),
    ).resolves.toMatchObject({ outcome: 'permanent_failure', attempts: 1 });

    expect(attempts).toBe(1);
    expect(diagnostics.join('\n')).toContain('HTTP 400');
  });

  it('returns a retryable failure after bounded network retries', async () => {
    const outbox = createOutbox(() => Promise.reject(new Error('connection refused')), {
      maxAttempts: 2,
    });

    await expect(
      outbox.enqueue({ eventId: 'network-source', payloads: [envelope('network-source', 0)] }),
    ).resolves.toMatchObject({ outcome: 'retryable_failure', attempts: 2 });
  });

  it('stops accepting work and aborts an in-flight request when drain expires', async () => {
    const arrived = deferred<void>();
    const outbox = createOutbox(
      (request) => {
        arrived.resolve();
        return new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      },
      { requestTimeoutMs: 1_000 },
    );
    void outbox.enqueue({ eventId: 'drain-source', payloads: [envelope('drain-source', 0)] });
    await arrived.promise;

    await expect(outbox.drain(10)).resolves.toBe(false);
    await expect(
      outbox.enqueue({ eventId: 'late-source', payloads: [envelope('late-source', 0)] }),
    ).rejects.toThrow('stopped');
  });
});

function createOutbox(
  request: (request: HookRequest) => Promise<{ statusCode: number }>,
  overrides: Partial<ConstructorParameters<typeof HookOutbox>[0]> = {},
): HookOutbox {
  return new HookOutbox({
    serverUrl: 'http://127.0.0.1:1',
    authToken: 'test-token',
    request,
    requestTimeoutMs: 50,
    maxAttempts: 3,
    backoffMs: () => 0,
    ...overrides,
  });
}

function envelope(
  eventId: string,
  index: number,
  hookEventName = 'CrewSessionStart',
): HookPayloadEnvelope {
  return {
    idempotencyKey: `${eventId}:${index}`,
    body: { hook_event_name: hookEventName, session_id: 'session-1' },
  };
}

function eventName(request: HookRequest): string {
  return String(request.body.hook_event_name);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => (resolve = done)), resolve };
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server has no TCP address');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function nextTick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
