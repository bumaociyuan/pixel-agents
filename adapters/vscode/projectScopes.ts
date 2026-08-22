import {
  createProjectScope,
  dedupeProjectScopes,
  type ProjectScope,
} from '../../core/src/projectScope.js';

export interface WorkspaceFolderLike {
  uri: { fsPath: string };
  name: string;
}

interface DisposableLike {
  dispose(): void;
}

interface WorkspaceScopeSource {
  workspaceFolders: readonly WorkspaceFolderLike[] | undefined;
  onDidChangeWorkspaceFolders(listener: () => void): DisposableLike;
}

/** Convert VS Code folders without coupling this pure builder to the VS Code runtime. */
export function buildVsCodeProjectScopes(folders: readonly WorkspaceFolderLike[]): ProjectScope[] {
  return dedupeProjectScopes(
    folders.map((folder) => createProjectScope(folder.uri.fsPath, folder.name)),
  );
}

/** Keep pi-crew scopes in sync without coupling scope composition to the VS Code runtime. */
export function watchVsCodeProjectScopes(
  workspace: WorkspaceScopeSource,
  setProjectScopes: (scopes: readonly ProjectScope[]) => void,
): DisposableLike {
  const replaceScopes = (): void => {
    setProjectScopes(buildVsCodeProjectScopes(workspace.workspaceFolders ?? []));
  };

  replaceScopes();
  return workspace.onDidChangeWorkspaceFolders(replaceScopes);
}
