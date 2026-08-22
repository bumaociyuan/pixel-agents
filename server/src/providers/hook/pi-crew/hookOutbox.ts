import * as http from 'node:http';
import * as https from 'node:https';

import {
  PI_CREW_HOOK_BACKOFF_BASE_MS,
  PI_CREW_HOOK_MAX_ATTEMPTS,
  PI_CREW_HOOK_REQUEST_TIMEOUT_MS,
} from './constants.js';

export interface HookPayloadEnvelope {
  idempotencyKey: string;
  body: Record<string, unknown>;
}

export interface HookOutboxItem {
  eventId: string;
  payloads: readonly HookPayloadEnvelope[];
}

export interface HookDeliveryResult {
  outcome: 'success' | 'permanent_failure' | 'retryable_failure';
  attempts: number;
  permanentFailures: number;
}

export interface HookRequest {
  url: URL;
  body: Record<string, unknown>;
  authToken: string;
  idempotencyKey: string;
  signal: AbortSignal;
}

export interface HookRequestResponse {
  statusCode: number;
}

export interface HookOutboxOptions {
  serverUrl: string;
  authToken: string;
  requestTimeoutMs?: number;
  maxAttempts?: number;
  backoffMs?: (retry: number) => number;
  onDiagnostic?: (message: string) => void;
  request?: (request: HookRequest) => Promise<HookRequestResponse>;
}

export interface HookOutboxLike {
  enqueue(item: HookOutboxItem): Promise<HookDeliveryResult>;
  drain(timeoutMs: number): Promise<boolean>;
}

type AttemptResult =
  | { kind: 'response'; statusCode: number }
  | { kind: 'network'; error: Error }
  | { kind: 'timeout' };

/** A serial queue that delivers the payloads from each source event in order. */
export class HookOutbox implements HookOutboxLike {
  private accepting = true;
  private disposed = false;
  private tail: Promise<void> = Promise.resolve();
  private readonly activeRequests = new Set<http.ClientRequest>();
  private readonly activeControllers = new Set<AbortController>();
  private readonly delays = new Map<ReturnType<typeof setTimeout>, () => void>();
  private readonly requestTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: (retry: number) => number;
  private readonly onDiagnostic: (message: string) => void;

  constructor(private readonly options: HookOutboxOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? PI_CREW_HOOK_REQUEST_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? PI_CREW_HOOK_MAX_ATTEMPTS;
    this.backoffMs =
      options.backoffMs ?? ((retry) => PI_CREW_HOOK_BACKOFF_BASE_MS * 2 ** (retry - 1));
    this.onDiagnostic =
      options.onDiagnostic ?? ((message) => console.warn(`[Pixel Agents] ${message}`));
  }

  enqueue(item: HookOutboxItem): Promise<HookDeliveryResult> {
    if (!this.accepting) return Promise.reject(new Error('Hook outbox is stopped'));

    const delivery = this.tail.then(() => this.deliver(item));
    this.tail = delivery.then(
      () => undefined,
      () => undefined,
    );
    return delivery;
  }

  /** Stop accepting work and wait for the serial queue for at most timeoutMs. */
  async drain(timeoutMs: number): Promise<boolean> {
    this.accepting = false;
    if (await settlesWithin(this.tail, timeoutMs)) return true;
    this.dispose();
    return false;
  }

  /** Abort active requests and wake retry delays. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.accepting = false;

    for (const wakeDelay of this.delays.values()) wakeDelay();
    this.delays.clear();
    for (const request of this.activeRequests) request.destroy(new Error('Hook outbox is stopped'));
    this.activeRequests.clear();
    for (const controller of this.activeControllers) controller.abort();
    this.activeControllers.clear();
  }

  private async deliver(item: HookOutboxItem): Promise<HookDeliveryResult> {
    let attempts = 0;
    let permanentFailures = 0;

    for (const payload of item.payloads) {
      const result = await this.deliverPayload(item.eventId, payload);
      attempts += result.attempts;
      if (result.outcome === 'retryable_failure') {
        return { outcome: 'retryable_failure', attempts, permanentFailures };
      }
      if (result.outcome === 'permanent_failure') permanentFailures += 1;
    }

    return {
      outcome: permanentFailures > 0 ? 'permanent_failure' : 'success',
      attempts,
      permanentFailures,
    };
  }

  private async deliverPayload(
    eventId: string,
    payload: HookPayloadEnvelope,
  ): Promise<HookDeliveryResult> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      if (this.disposed) {
        return { outcome: 'retryable_failure', attempts: attempt - 1, permanentFailures: 0 };
      }

      const result = await this.request(payload);
      if (result.kind === 'response' && result.statusCode >= 200 && result.statusCode < 300) {
        return { outcome: 'success', attempts: attempt, permanentFailures: 0 };
      }
      if (result.kind === 'response' && isPermanentStatus(result.statusCode)) {
        this.onDiagnostic(
          `pi-crew hook permanent delivery failure for ${eventId} (${payload.idempotencyKey}): HTTP ${result.statusCode}`,
        );
        return { outcome: 'permanent_failure', attempts: attempt, permanentFailures: 1 };
      }
      if (attempt === this.maxAttempts || this.disposed) {
        this.onDiagnostic(
          `pi-crew hook retryable delivery failure for ${eventId} (${payload.idempotencyKey}) after ${attempt} attempts: ${attemptResultReason(result)}`,
        );
        return { outcome: 'retryable_failure', attempts: attempt, permanentFailures: 0 };
      }

      await this.delay(this.backoffMs(attempt));
    }

    return { outcome: 'retryable_failure', attempts: this.maxAttempts, permanentFailures: 0 };
  }

  private request(payload: HookPayloadEnvelope): Promise<AttemptResult> {
    return this.options.request
      ? this.requestWithInjectedTransport(payload, this.options.request)
      : this.requestOverHttp(payload);
  }

  private requestOverHttp(payload: HookPayloadEnvelope): Promise<AttemptResult> {
    const body = JSON.stringify(payload.body);
    const url = hookUrl(this.options.serverUrl);
    const transport = url.protocol === 'https:' ? https : http;

    return new Promise((resolve) => {
      let settled = false;
      let timedOut = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: AttemptResult): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        this.activeRequests.delete(request);
        resolve(result);
      };
      const request = transport.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Authorization: `Bearer ${this.options.authToken}`,
            'X-Pixel-Agents-Idempotency-Key': payload.idempotencyKey,
          },
        },
        (response) => {
          response.resume();
          finish({ kind: 'response', statusCode: response.statusCode ?? 0 });
        },
      );

      timeout = setTimeout(() => {
        timedOut = true;
        request.destroy(new Error('Hook request timed out'));
        finish({ kind: 'timeout' });
      }, this.requestTimeoutMs);
      this.activeRequests.add(request);
      request.once('error', (error) => {
        finish(timedOut ? { kind: 'timeout' } : { kind: 'network', error });
      });
      request.end(body);
    });
  }

  private requestWithInjectedTransport(
    payload: HookPayloadEnvelope,
    send: (request: HookRequest) => Promise<HookRequestResponse>,
  ): Promise<AttemptResult> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;

    return new Promise((resolve) => {
      let settled = false;
      let timedOut = false;
      const finish = (result: AttemptResult): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        this.activeControllers.delete(controller);
        resolve(result);
      };

      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        finish({ kind: 'timeout' });
      }, this.requestTimeoutMs);
      this.activeControllers.add(controller);
      void send({
        url: hookUrl(this.options.serverUrl),
        body: payload.body,
        authToken: this.options.authToken,
        idempotencyKey: payload.idempotencyKey,
        signal: controller.signal,
      }).then(
        (response) => finish({ kind: 'response', statusCode: response.statusCode }),
        (error: unknown) =>
          finish(
            timedOut
              ? { kind: 'timeout' }
              : {
                  kind: 'network',
                  error: error instanceof Error ? error : new Error(String(error)),
                },
          ),
      );
    });
  }

  private delay(ms: number): Promise<void> {
    if (this.disposed || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.delays.delete(timer);
        resolve();
      }, ms);
      this.delays.set(timer, () => {
        clearTimeout(timer);
        this.delays.delete(timer);
        resolve();
      });
    });
  }
}

function hookUrl(serverUrl: string): URL {
  return new URL(`/api/hooks/${encodeURIComponent('pi-crew')}`, serverUrl);
}

function isPermanentStatus(statusCode: number): boolean {
  return statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429;
}

function attemptResultReason(result: AttemptResult): string {
  if (result.kind === 'response') return `HTTP ${result.statusCode}`;
  if (result.kind === 'timeout') return 'request timeout';
  return result.error.message;
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
