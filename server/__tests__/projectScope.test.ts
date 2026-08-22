import { describe, expect, it } from 'vitest';

import {
  canonicalizeProjectPath,
  createProjectScope,
  dedupeProjectScopes,
  projectKeyFromPath,
} from '../../core/src/projectScope.js';

describe('project scope identity', () => {
  it('keeps same-basename projects distinct', () => {
    expect(projectKeyFromPath('/a/frontend')).not.toBe(projectKeyFromPath('/b/frontend'));
  });

  it('deduplicates normalized aliases', () => {
    const a = createProjectScope('/tmp/work/../work');
    const b = createProjectScope('/tmp/work');

    expect(dedupeProjectScopes([a, b])).toHaveLength(1);
  });

  it('canonicalizes paths before deriving identity', () => {
    expect(canonicalizeProjectPath('/tmp/work/../work')).toBe('/tmp/work');
    expect(projectKeyFromPath('/tmp/work/../work')).toBe(projectKeyFromPath('/tmp/work'));
  });

  it('uses the basename as the default display name', () => {
    expect(createProjectScope('/a/frontend')).toEqual({
      key: projectKeyFromPath('/a/frontend'),
      path: canonicalizeProjectPath('/a/frontend'),
      displayName: 'frontend',
    });
  });

  it('accepts an explicit display name without changing identity', () => {
    const scope = createProjectScope('/a/frontend', 'Frontend App');

    expect(scope.displayName).toBe('Frontend App');
    expect(scope.key).toBe(projectKeyFromPath('/a/frontend'));
  });

  it('deduplicates by key while preserving first scope', () => {
    const first = createProjectScope('/tmp/work', 'First');
    const alias = createProjectScope('/tmp/work/../work', 'Alias');

    expect(dedupeProjectScopes([first, alias])).toEqual([first]);
  });

  it('creates a stable truncated path digest', () => {
    expect(projectKeyFromPath('/a/frontend')).toMatch(/^path:[A-Za-z0-9_-]{16}$/);
  });
});
