import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const DEFAULT_CHUNK_SIZE = 64 * 1024;
const FINGERPRINT_BYTES = 4096;
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
  private decoder = new StringDecoder('utf8');
  private lineBuffer = '';
  private records: ParsedJsonlRecord<T>[] = [];
  private lastDiagnosticAt = Number.NEGATIVE_INFINITY;
  private readonly chunkSize: number;

  constructor(
    private readonly filePath: string,
    private readonly options: IncrementalJsonlReaderOptions = {},
  ) {
    const checkpoint = options.checkpoint;
    this.committedOffset = checkpoint?.committedOffset ?? 0;
    this.readOffset = this.committedOffset;
    this.lineStartOffset = this.committedOffset;
    this.fileIdentity = checkpoint?.fileIdentity;
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
    }
    this.fileIdentity = observed.identity;

    if (observed.size > this.readOffset) {
      this.readTo(observed.size);
    }

    return [...this.records];
  }

  commit(endOffset: number): void {
    if (!Number.isInteger(endOffset) || endOffset < this.committedOffset) return;

    this.committedOffset = Math.min(endOffset, this.readOffset);
    this.records = this.records.filter((record) => record.endOffset > this.committedOffset);
  }

  reset(): void {
    this.committedOffset = 0;
    this.readOffset = 0;
    this.lineStartOffset = 0;
    this.fileIdentity = undefined;
    this.decoder = new StringDecoder('utf8');
    this.lineBuffer = '';
    this.records = [];
  }

  snapshot(): JsonlCheckpoint {
    return {
      committedOffset: this.committedOffset,
      ...(this.fileIdentity ? { fileIdentity: { ...this.fileIdentity } } : {}),
      recentEventIds: [],
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
    return currentFingerprint !== previous.firstBlockFingerprint;
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
        this.consumeText(this.decoder.write(buffer.subarray(0, bytesRead)));
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  private consumeText(text: string): void {
    this.lineBuffer += text;

    let newlineIndex = this.lineBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      const endOffset = this.lineStartOffset + Buffer.byteLength(line, 'utf8') + 1;
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);

      if (line.trim()) {
        try {
          this.records.push({
            startOffset: this.lineStartOffset,
            endOffset,
            value: JSON.parse(line) as T,
          });
        } catch {
          this.reportMalformedLine(this.lineStartOffset);
        }
      }

      this.lineStartOffset = endOffset;
      newlineIndex = this.lineBuffer.indexOf('\n');
    }
  }

  private reportMalformedLine(offset: number): void {
    const now = Date.now();
    if (now - this.lastDiagnosticAt < DIAGNOSTIC_INTERVAL_MS) return;
    this.lastDiagnosticAt = now;
    this.options.onDiagnostic?.(`Malformed JSONL record at byte offset ${offset}`);
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
