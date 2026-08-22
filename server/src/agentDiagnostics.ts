import * as fs from 'node:fs';

import type { AgentStateStore } from './agentStateStore.js';

/**
 * Per-agent connection diagnostics. Structurally mirrors the `AgentDiagnostics`
 * shape consumed by the webview Debug View, so this payload drops straight into
 * the `agents` array of an `agentDiagnostics` ServerMessage.
 */
export interface AgentDiagnosticsEntry {
  id: number;
  projectDir: string;
  projectDirExists: boolean;
  jsonlFile: string;
  jsonlExists: boolean;
  fileSize: number;
  fileOffset: number;
  lastDataAt: number;
  linesProcessed: number;
}

export interface PiCrewDiagnosticInput {
  category: 'reader' | 'delivery' | 'checkpoint' | 'migration' | 'watcher';
  message: string;
  projectKey?: string;
  runId?: string;
  file?: string;
  offset?: number;
  eventId?: string;
}

export interface PiCrewDiagnostic extends PiCrewDiagnosticInput {
  count: number;
  lastSeenAt: number;
  lastEmittedAt: number;
}

export interface PiCrewDiagnosticRecordResult {
  diagnostic: PiCrewDiagnostic;
  isNew: boolean;
  shouldEmit: boolean;
}

export interface AgentDiagnosticsReport {
  agents: AgentDiagnosticsEntry[];
  piCrewDiagnostics: PiCrewDiagnostic[];
}

const MAX_PI_CREW_DIAGNOSTICS = 50;
const PI_CREW_DIAGNOSTIC_EMIT_INTERVAL_MS = 1_000;
const piCrewDiagnostics: PiCrewDiagnostic[] = [];

/** Retain a bounded, de-duplicated record of watcher failures for Debug View and support. */
export function recordPiCrewDiagnostic(input: PiCrewDiagnosticInput): PiCrewDiagnosticRecordResult {
  const message = redactBearerToken(input.message);
  const now = Date.now();
  const existing = piCrewDiagnostics.find(
    (diagnostic) =>
      diagnostic.category === input.category &&
      diagnostic.message === message &&
      diagnostic.projectKey === input.projectKey &&
      diagnostic.runId === input.runId &&
      diagnostic.file === input.file &&
      diagnostic.offset === input.offset &&
      diagnostic.eventId === input.eventId,
  );
  if (existing) {
    existing.count += 1;
    existing.lastSeenAt = now;
    const shouldEmit = now - existing.lastEmittedAt >= PI_CREW_DIAGNOSTIC_EMIT_INTERVAL_MS;
    if (shouldEmit) existing.lastEmittedAt = now;
    return { diagnostic: { ...existing }, isNew: false, shouldEmit };
  }
  const diagnostic = { ...input, message, count: 1, lastSeenAt: now, lastEmittedAt: now };
  piCrewDiagnostics.push(diagnostic);
  while (piCrewDiagnostics.length > MAX_PI_CREW_DIAGNOSTICS) piCrewDiagnostics.shift();
  return { diagnostic: { ...diagnostic }, isNew: true, shouldEmit: true };
}

/** Test-only reset for the process-wide diagnostic ring buffer. */
export function clearPiCrewDiagnosticsForTests(): void {
  piCrewDiagnostics.length = 0;
}

/**
 * Build the connection-diagnostics payload for every agent in the store.
 *
 * Shared by the VS Code adapter and the standalone server so both surfaces emit
 * an identical `agentDiagnostics` payload. `jsonlExists` and `fileSize` are
 * coupled: both come from a single `fs.statSync` (the "has data but 0 lines"
 * Debug View branch depends on this), while `projectDirExists` is a separate
 * `fs.existsSync`. `lastDataAt === 0` is a meaningful "never" sentinel and is
 * forwarded as-is.
 */
export function buildAgentDiagnostics(store: AgentStateStore): AgentDiagnosticsReport {
  const agents: AgentDiagnosticsEntry[] = [];
  for (const agent of store.values()) {
    let jsonlExists = false;
    let fileSize = 0;
    try {
      const stat = fs.statSync(agent.jsonlFile);
      jsonlExists = true;
      fileSize = stat.size;
    } catch {
      /* file doesn't exist */
    }
    agents.push({
      id: agent.id,
      projectDir: agent.projectDir,
      projectDirExists: fs.existsSync(agent.projectDir),
      jsonlFile: agent.jsonlFile,
      jsonlExists,
      fileSize,
      fileOffset: agent.fileOffset,
      lastDataAt: agent.lastDataAt,
      linesProcessed: agent.linesProcessed,
    });
  }
  return {
    agents,
    piCrewDiagnostics: piCrewDiagnostics.map((diagnostic) => ({ ...diagnostic })),
  };
}

function redactBearerToken(message: string): string {
  const sensitiveKey =
    '(?:authorization|authToken|access_token|refresh_token|token|apiKey|api_key|x-api-key|password|passwd|secret|client_secret|clientSecret|cookie|set-cookie)';
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(new RegExp(`([?&]${sensitiveKey}=)[^&#\\s]+`, 'gi'), '$1[redacted]')
    .replace(
      new RegExp(`("${sensitiveKey}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'gi'),
      '$1"[redacted]"',
    )
    .replace(new RegExp(`(${sensitiveKey}\\s*[=:]\\s*)[^\\s,;}&]+`, 'gi'), '$1[redacted]')
    .replace(/(Cookie\s*:\s*)[^\r\n]+/gi, '$1[redacted]')
    .replace(/(Set-Cookie\s*:\s*)[^\r\n]+/gi, '$1[redacted]');
}
