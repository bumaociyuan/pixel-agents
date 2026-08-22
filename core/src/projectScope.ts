import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import * as path from 'node:path';

export interface ProjectScope {
  key: string;
  path: string;
  displayName: string;
}

export function canonicalizeProjectPath(input: string): string {
  const resolved = path.resolve(input);
  let canonical = resolved;

  try {
    canonical = realpathSync.native(resolved);
  } catch {
    // A project may not exist yet; the resolved path is still a stable identity.
  }

  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

export function projectKeyFromPath(input: string): string {
  return `path:${createHash('sha256')
    .update(canonicalizeProjectPath(input))
    .digest('base64url')
    .slice(0, 16)}`;
}

export function createProjectScope(input: string, displayName?: string): ProjectScope {
  const canonicalPath = canonicalizeProjectPath(input);

  return {
    key: projectKeyFromPath(canonicalPath),
    path: canonicalPath,
    displayName: displayName ?? path.basename(canonicalPath),
  };
}

export function dedupeProjectScopes(scopes: readonly ProjectScope[]): ProjectScope[] {
  const seen = new Set<string>();
  const result: ProjectScope[] = [];

  for (const scope of scopes) {
    if (seen.has(scope.key)) {
      continue;
    }
    seen.add(scope.key);
    result.push(scope);
  }

  return result;
}
