import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { TextDecoder } from 'node:util';

import { PI_CREW_RECENT_EVENT_IDS_MAX } from './constants.js';

const DEFAULT_CHUNK_SIZE = 64 * 1024;
const FINGERPRINT_BYTES = 4096;
const COMMIT_ANCHOR_BYTES = 1024;
const DIAGNOSTIC_INTERVAL_MS = 1000;

export interface JsonlFileIdentity {
  dev: number;
  ino: number;
  size: number;
  firstBlockFingerprint: string;
  fingerprintLength: number;
}

export interface JsonlCheckpoint {
  committedOffset: number;
  fileIdentity?: JsonlFileIdentity;
  recentEventIds: string[];
  committedAnchor?: JsonlByteAnchor;
}

export interface JsonlByteAnchor {
  offset: number;
  length: number;
  fingerprint: string;
}

export interface ParsedJsonlRecord<T> {
  startOffset: number;
  endOffset: number;
  value: T;
}

export interface IncrementalJsonlReaderOptions {
  checkpoint?: JsonlCheckpoint;
  chunkSize?: number;
  onDiagnostic?: (message: string) => void;
  onReset?: () => void;
}

interface ObservedFile {
  identity: JsonlFileIdentity;
  size: number;
}

/** Reads only complete JSONL records while retaining partial UTF-8 and lines between polls. */
export class IncrementalJsonlReader<T> {
  private committedOffset: number;
  private readOffset: number;
  private lineStartOffset: number;
  private fileIdentity?: JsonlFileIdentity;
  private committedAnchor?: JsonlByteAnchor;
  private lineParts: Buffer[] = [];
  private lineLength = 0;
  private records: ParsedJsonlRecord<T>[] = [];
  private malformedAfterLastValidRecord = false;
  private lastDiagnosticAt = Number.NEGATIVE_INFINITY;
  private readonly chunkSize: number;
  private readonly strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true });
  private readonly recentEventIds: string[];

  constructor(
    private readonly filePath: string,
    private readonly options: IncrementalJsonlReaderOptions = {},
  ) {
    const checkpoint = options.checkpoint;
    this.committedOffset = checkpoint?.committedOffset ?? 0;
    this.readOffset = this.committedOffset;
    this.lineStartOffset = this.committedOffset;
    this.fileIdentity = checkpoint?.fileIdentity;
    this.committedAnchor = checkpoint?.committedAnchor;
    this.recentEventIds = [...(checkpoint?.recentEventIds ?? [])];
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;

    if (!Number.isInteger(this.chunkSize) || this.chunkSize <= 0) {
      throw new Error('chunkSize must be a positive integer');
    }
  }

  readAvailable(): ParsedJsonlRecord<T>[] {
    const observed = this.observeFile();
    if (!observed) return [];

    if (this.requiresReset(observed)) {
      this.reset();
      this.options.onReset?.();
    }
    this.fileIdentity = observed.identity;

    if (observed.size > this.readOffset) {
      this.readTo(observed.size);
    }

    return [...this.records];
  }

  commit(endOffset: number): void {
    if (!Number.isInteger(endOffset) || endOffset === this.committedOffset) return;
    if (!this.records.some((record) => record.endOffset === endOffset)) return;

    this.committedOffset = endOffset;
    this.committedAnchor = this.captureAnchor(endOffset);
    this.records = this.records.filter((record) => record.endOffset > this.committedOffset);
  }

  reset(): void {
    this.committedOffset = 0;
    this.readOffset = 0;
    this.lineStartOffset = 0;
    this.fileIdentity = undefined;
    this.committedAnchor = undefined;
    this.lineParts = [];
    this.lineLength = 0;
    this.records = [];
    this.malformedAfterLastValidRecord = false;
  }

  hasRecentEventId(eventId: string): boolean {
    return this.recentEventIds.includes(eventId);
  }

  rememberEventId(eventId: string): void {
    const existingIndex = this.recentEventIds.indexOf(eventId);
    if (existingIndex >= 0) this.recentEventIds.splice(existingIndex, 1);
    this.recentEventIds.push(eventId);
    if (this.recentEventIds.length > PI_CREW_RECENT_EVENT_IDS_MAX) {
      this.recentEventIds.splice(0, this.recentEventIds.length - PI_CREW_RECENT_EVENT_IDS_MAX);
    }
  }

  hasUncertainTrailingData(): boolean {
    return this.lineLength > 0 || this.malformedAfterLastValidRecord;
  }

  prepareCommit(endOffset: number, eventId?: string): JsonlCheckpoint | null {
    if (
      !Number.isInteger(endOffset) ||
      !this.records.some((record) => record.endOffset === endOffset)
    ) {
      return null;
    }
    const recentEventIds = [...this.recentEventIds];
    if (eventId) addRecentEventId(recentEventIds, eventId);
    const committedAnchor = this.captureAnchor(endOffset);
    return {
      committedOffset: endOffset,
      ...(this.fileIdentity ? { fileIdentity: { ...this.fileIdentity } } : {}),
      ...(committedAnchor ? { committedAnchor } : {}),
      recentEventIds,
    };
  }

  finalizeCommit(checkpoint: JsonlCheckpoint): void {
    if (!this.records.some((record) => record.endOffset === checkpoint.committedOffset)) return;
    this.committedOffset = checkpoint.committedOffset;
    this.fileIdentity = checkpoint.fileIdentity ? { ...checkpoint.fileIdentity } : undefined;
    this.committedAnchor = checkpoint.committedAnchor
      ? { ...checkpoint.committedAnchor }
      : undefined;
    this.recentEventIds.splice(0, this.recentEventIds.length, ...checkpoint.recentEventIds);
    this.records = this.records.filter((record) => record.endOffset > this.committedOffset);
  }

  snapshot(): JsonlCheckpoint {
    return {
      committedOffset: this.committedOffset,
      ...(this.fileIdentity ? { fileIdentity: { ...this.fileIdentity } } : {}),
      ...(this.committedAnchor ? { committedAnchor: { ...this.committedAnchor } } : {}),
      recentEventIds: [...this.recentEventIds],
    };
  }

  private observeFile(): ObservedFile | null {
    let fd: number | undefined;
    try {
      const stat = fs.statSync(this.filePath);
      const fingerprintLength = Math.min(stat.size, FINGERPRINT_BYTES);
      const buffer = Buffer.alloc(fingerprintLength);
      fd = fs.openSync(this.filePath, 'r');
      const bytesRead = fs.readSync(fd, buffer, 0, fingerprintLength, 0);
      const firstBlockFingerprint = hash(buffer.subarray(0, bytesRead));

      return {
        size: stat.size,
        identity: {
          dev: stat.dev,
          ino: stat.ino,
          size: stat.size,
          firstBlockFingerprint,
          fingerprintLength: bytesRead,
        },
      };
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  private requiresReset(observed: ObservedFile): boolean {
    if (observed.size < this.committedOffset) return true;
    if (!this.fileIdentity) return false;
    if (observed.size < this.fileIdentity.size) return true;

    const previous = this.fileIdentity;
    if (hasStableInode(previous) && hasStableInode(observed.identity)) {
      if (previous.dev !== observed.identity.dev || previous.ino !== observed.identity.ino)
        return true;
    }

    if (observed.size < previous.fingerprintLength) return true;
    const currentFingerprint = this.fingerprintForLength(previous.fingerprintLength);
    if (currentFingerprint !== previous.firstBlockFingerprint) return true;

    return !this.matchesCommittedAnchor();
  }

  private fingerprintForLength(length: number): string {
    let fd: number | undefined;
    try {
      const buffer = Buffer.alloc(length);
      fd = fs.openSync(this.filePath, 'r');
      const bytesRead = fs.readSync(fd, buffer, 0, length, 0);
      return hash(buffer.subarray(0, bytesRead));
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  private readTo(endOffset: number): void {
    let fd: number | undefined;
    try {
      fd = fs.openSync(this.filePath, 'r');
      while (this.readOffset < endOffset) {
        const bytesToRead = Math.min(this.chunkSize, endOffset - this.readOffset);
        const buffer = Buffer.alloc(bytesToRead);
        const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, this.readOffset);
        if (bytesRead === 0) break;

        this.readOffset += bytesRead;
        this.consumeBytes(buffer.subarray(0, bytesRead));
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  private consumeBytes(bytes: Buffer): void {
    let start = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] !== 0x0a) continue;

      this.appendLinePart(bytes.subarray(start, index));
      const lineBytes = Buffer.concat(this.lineParts, this.lineLength);
      const endOffset = this.lineStartOffset + lineBytes.length + 1;
      this.lineParts = [];
      this.lineLength = 0;

      try {
        const line = this.decodeUtf8(lineBytes);
        if (line.trim()) {
          this.records.push({
            startOffset: this.lineStartOffset,
            endOffset,
            value: JSON.parse(line) as T,
          });
          this.malformedAfterLastValidRecord = false;
        }
      } catch {
        this.malformedAfterLastValidRecord = true;
        this.reportMalformedLine(this.lineStartOffset);
      }

      this.lineStartOffset = endOffset;
      start = index + 1;
    }

    this.appendLinePart(bytes.subarray(start));
  }

  private appendLinePart(part: Buffer): void {
    if (part.length === 0) return;
    this.lineParts.push(part);
    this.lineLength += part.length;
  }

  private decodeUtf8(lineBytes: Buffer): string {
    this.strictUtf8Decoder.decode(lineBytes);
    const decoder = new StringDecoder('utf8');
    return decoder.write(lineBytes) + decoder.end();
  }

  private captureAnchor(endOffset: number): JsonlByteAnchor | undefined {
    const offset = Math.max(0, endOffset - COMMIT_ANCHOR_BYTES);
    const length = endOffset - offset;
    const fingerprint = this.fingerprintRange(offset, length);
    return fingerprint ? { offset, length, fingerprint } : undefined;
  }

  private matchesCommittedAnchor(): boolean {
    if (!this.committedAnchor) return true;
    const { offset, length, fingerprint } = this.committedAnchor;
    return this.fingerprintRange(offset, length) === fingerprint;
  }

  private fingerprintRange(offset: number, length: number): string | undefined {
    let fd: number | undefined;
    try {
      const buffer = Buffer.alloc(length);
      fd = fs.openSync(this.filePath, 'r');
      const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
      if (bytesRead !== length) return undefined;
      return hash(buffer);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  private reportMalformedLine(offset: number): void {
    const now = Date.now();
    if (now - this.lastDiagnosticAt < DIAGNOSTIC_INTERVAL_MS) return;
    this.lastDiagnosticAt = now;
    this.options.onDiagnostic?.(`Malformed JSONL record at byte offset ${offset}`);
  }
}

function addRecentEventId(recentEventIds: string[], eventId: string): void {
  const existingIndex = recentEventIds.indexOf(eventId);
  if (existingIndex >= 0) recentEventIds.splice(existingIndex, 1);
  recentEventIds.push(eventId);
  if (recentEventIds.length > PI_CREW_RECENT_EVENT_IDS_MAX) {
    recentEventIds.splice(0, recentEventIds.length - PI_CREW_RECENT_EVENT_IDS_MAX);
  }
}

function hash(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function hasStableInode(identity: JsonlFileIdentity): boolean {
  return identity.dev !== 0 && identity.ino !== 0;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}
