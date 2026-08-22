import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LAYOUT_FILE_DIR } from '../../../constants.js';
import { PI_CREW_CHECKPOINTS_DIR, PI_CREW_RECENT_EVENT_IDS_MAX } from './constants.js';
import type { JsonlByteAnchor, JsonlCheckpoint, JsonlFileIdentity } from './jsonlReader.js';

export interface PiCrewCheckpointStoreOptions {
  /** Pixel Agents state directory. Checkpoints are never stored in the watched project. */
  rootDir?: string;
  onDiagnostic?: (message: string) => void;
  fileSystem?: CheckpointFileSystem;
}

interface CheckpointFileSystem {
  mkdirSync: typeof fs.mkdirSync;
  readFileSync: typeof fs.readFileSync;
  openSync: typeof fs.openSync;
  writeFileSync: typeof fs.writeFileSync;
  fsyncSync: typeof fs.fsyncSync;
  closeSync: typeof fs.closeSync;
  renameSync: typeof fs.renameSync;
  unlinkSync: typeof fs.unlinkSync;
}

/** Persists one reader checkpoint per stable project/run identity. */
export class PiCrewCheckpointStore {
  private tempSequence = 0;
  private readonly rootDir: string;
  private readonly files: CheckpointFileSystem;

  constructor(private readonly options: PiCrewCheckpointStoreOptions = {}) {
    this.rootDir =
      options.rootDir ?? path.join(os.homedir(), LAYOUT_FILE_DIR, PI_CREW_CHECKPOINTS_DIR);
    this.files = options.fileSystem ?? fs;
  }

  load(projectKey: string, runId: string): JsonlCheckpoint | null {
    const checkpointPath = this.checkpointPath(projectKey, runId);
    let raw: string;
    try {
      raw = this.files.readFileSync(checkpointPath, 'utf8');
    } catch (error) {
      if (isMissing(error)) return null;
      this.reportDiagnostic(projectKey, runId, `cannot read checkpoint: ${errorMessage(error)}`);
      return null;
    }

    try {
      return parseCheckpoint(JSON.parse(raw));
    } catch (error) {
      this.reportDiagnostic(projectKey, runId, `corrupt checkpoint: ${errorMessage(error)}`);
      return null;
    }
  }

  save(projectKey: string, runId: string, checkpoint: JsonlCheckpoint): void {
    const checkpointPath = this.checkpointPath(projectKey, runId);
    const directory = path.dirname(checkpointPath);
    this.files.mkdirSync(directory, { recursive: true });

    const normalized = normalizeCheckpoint(checkpoint);
    const tempPath = path.join(
      directory,
      `.${path.basename(checkpointPath)}.tmp-${process.pid}-${this.tempSequence++}`,
    );
    let fd: number | undefined;
    let renamed = false;
    try {
      fd = this.files.openSync(tempPath, 'w', 0o600);
      this.files.writeFileSync(fd, JSON.stringify(normalized));
      this.files.fsyncSync(fd);
      this.files.closeSync(fd);
      fd = undefined;
      this.files.renameSync(tempPath, checkpointPath);
      renamed = true;
    } catch (error) {
      if (fd !== undefined) {
        try {
          this.files.closeSync(fd);
        } catch {
          // The original failure is more useful than a cleanup failure.
        }
      }
      try {
        if (!renamed) this.files.unlinkSync(tempPath);
      } catch {
        // The original checkpoint remains intact; cleanup is best effort.
      }
      throw error;
    }
  }

  remove(projectKey: string, runId: string): void {
    try {
      this.files.unlinkSync(this.checkpointPath(projectKey, runId));
    } catch (error) {
      if (!isMissing(error)) {
        this.reportDiagnostic(
          projectKey,
          runId,
          `cannot remove checkpoint: ${errorMessage(error)}`,
        );
      }
    }
  }

  private checkpointPath(projectKey: string, runId: string): string {
    return path.join(this.rootDir, encodeKey(projectKey), `${encodeKey(runId)}.json`);
  }

  private reportDiagnostic(projectKey: string, runId: string, detail: string): void {
    this.options.onDiagnostic?.(
      `pi-crew checkpoint [project=${projectKey} run=${runId}]: ${detail}`,
    );
  }
}

function normalizeCheckpoint(checkpoint: JsonlCheckpoint): JsonlCheckpoint {
  return {
    committedOffset: checkpoint.committedOffset,
    ...(checkpoint.fileIdentity ? { fileIdentity: { ...checkpoint.fileIdentity } } : {}),
    ...(checkpoint.committedAnchor ? { committedAnchor: { ...checkpoint.committedAnchor } } : {}),
    recentEventIds: checkpoint.recentEventIds.slice(-PI_CREW_RECENT_EVENT_IDS_MAX),
  };
}

function parseCheckpoint(value: unknown): JsonlCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('expected object');
  const checkpoint = value as Partial<JsonlCheckpoint>;
  const committedOffset = checkpoint.committedOffset;
  if (
    typeof committedOffset !== 'number' ||
    !Number.isInteger(committedOffset) ||
    committedOffset < 0
  ) {
    throw new Error('invalid committed offset');
  }
  if (!Array.isArray(checkpoint.recentEventIds) || !checkpoint.recentEventIds.every(isString)) {
    throw new Error('invalid recent event IDs');
  }
  if (checkpoint.fileIdentity !== undefined && !isFileIdentity(checkpoint.fileIdentity)) {
    throw new Error('invalid file identity');
  }
  if (checkpoint.committedAnchor !== undefined && !isByteAnchor(checkpoint.committedAnchor)) {
    throw new Error('invalid committed anchor');
  }
  return normalizeCheckpoint({
    committedOffset,
    recentEventIds: checkpoint.recentEventIds,
    ...(checkpoint.fileIdentity ? { fileIdentity: checkpoint.fileIdentity } : {}),
    ...(checkpoint.committedAnchor ? { committedAnchor: checkpoint.committedAnchor } : {}),
  });
}

function encodeKey(key: string): string {
  return Buffer.from(key, 'utf8').toString('base64url');
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isFileIdentity(value: unknown): value is JsonlFileIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Partial<JsonlFileIdentity>;
  return (
    isNonNegativeInteger(identity.dev) &&
    isNonNegativeInteger(identity.ino) &&
    isNonNegativeInteger(identity.size) &&
    isNonNegativeInteger(identity.fingerprintLength) &&
    typeof identity.firstBlockFingerprint === 'string'
  );
}

function isByteAnchor(value: unknown): value is JsonlByteAnchor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const anchor = value as Partial<JsonlByteAnchor>;
  return (
    isNonNegativeInteger(anchor.offset) &&
    isNonNegativeInteger(anchor.length) &&
    typeof anchor.fingerprint === 'string'
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
