import { createProjectScope, type ProjectScope } from '../../core/src/projectScope.js';

/** The standalone process owns exactly the directory it was launched from. */
export function buildStandaloneProjectScopes(cwd: string): ProjectScope[] {
  return [createProjectScope(cwd)];
}
