import type { DeployFailure, WorkspaceFile } from '@sf-claws/shared';
import { sha256 } from '../lib/crypto.js';

export const COMPILE_INTERVAL_MS = 10 * 60_000;
export const COMPILE_FILE_LIMIT = 8;
export interface RootDiagnostic {
  key: string;
  problems: string[];
  components: string[];
}
export interface CompileState {
  dirtySince: number | null;
  dirtyPaths: string[];
  checkedFiles: Record<string, string>;
  roots: RootDiagnostic[];
  repairKeys: string[];
  scopeKeys: string[];
  lastFailedHash: string | null;
  noProgress: number;
  stopped: string | null;
  checks: number;
}
export const initialCompileState = (): CompileState => ({
  dirtySince: null,
  dirtyPaths: [],
  checkedFiles: {},
  roots: [],
  repairKeys: [],
  scopeKeys: [],
  lastFailedHash: null,
  noProgress: 0,
  stopped: null,
  checks: 0,
});
export const componentKey = (f: Pick<WorkspaceFile, 'path' | 'metadataType' | 'fullName'>) =>
  f.metadataType && f.fullName ? `${f.metadataType}:${f.fullName}` : `file:${f.path}`;
export const fileHash = (f: WorkspaceFile) => sha256(`${f.action}\n${f.content}`);
export const compileHash = (files: WorkspaceFile[], options: unknown) =>
  sha256(JSON.stringify([files.map((f) => [f.path, fileHash(f)]).sort((a, b) => a[0].localeCompare(b[0])), options]));

/** Collapse recompilation cascades onto the deepest named class, retaining affected components. */
export function rootDiagnostics(failures: DeployFailure[]): RootDiagnostic[] {
  const primaryNames = new Set(
    failures
      .filter((f) => !/Dependent class is invalid/i.test(f.problem))
      .map((f) => f.fullName)
      .filter(Boolean),
  );
  const roots = new Map<string, RootDiagnostic>();
  for (const f of failures) {
    if (/UNKNOWN_EXCEPTION/i.test(f.problem)) continue;
    // Infrastructure failures are not compiler diagnostics.
    if (!f.componentType && !f.fullName && !f.fileName) continue;
    const component = `${f.componentType ?? 'file'}:${f.fullName ?? f.fileName ?? 'unknown'}`;
    const cascade = /Dependent class is invalid/i.test(f.problem) ? [...f.problem.matchAll(/Class\s+([\w]+)\s*:/g)].at(-1)?.[1] : null;
    const missing = /Variable does not exist:\s*(\w+)\s*$/i.exec(f.problem)?.[1];
    const key = cascade ? `ApexClass:${cascade}` : missing && primaryNames.has(missing) ? `ApexClass:${missing}` : component;
    const root = roots.get(key) ?? { key, problems: [], components: [] };
    if (!root.problems.includes(f.problem)) root.problems.push(f.problem);
    if (!root.components.includes(component)) root.components.push(component);
    roots.set(key, root);
  }
  return [...roots.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function references(source: string, file: WorkspaceFile): boolean {
  if (!file.fullName) return false;
  // Conservative source-name heuristic until the dependency graph is introduced.
  const names = [file.fullName, file.fullName.split('.').at(-1)!];
  return names.some((name) => new RegExp(`(?<![\\w])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`).test(source));
}

/** Keep companions together, include staged schema, then close over referenced staged components. */
export function compileSlice(files: WorkspaceFile[], paths: string[]): WorkspaceFile[] {
  const wanted = new Set(paths);
  const keys = new Set(files.filter((f) => wanted.has(f.path) || /^(CustomObject|CustomField|CustomMetadata)$/.test(f.metadataType ?? '')).map(componentKey));
  let changed = true;
  while (changed) {
    changed = false;
    const source = files
      .filter((f) => keys.has(componentKey(f)))
      .map((f) => f.content)
      .join('\n');
    for (const f of files)
      if (!keys.has(componentKey(f)) && references(source, f)) {
        keys.add(componentKey(f));
        changed = true;
      }
  }
  return files.filter((f) => keys.has(componentKey(f)));
}

export function missingCompanions(files: WorkspaceFile[]): string[] {
  const paths = new Set(files.map((f) => f.path));
  return files.filter((f) => f.action !== 'deleted' && /\.(cls|trigger)$/.test(f.path) && !paths.has(`${f.path}-meta.xml`)).map((f) => `${f.path}-meta.xml`);
}

export function repairComponents(roots: RootDiagnostic[], files: WorkspaceFile[]): string[] {
  const keys = new Set(roots.flatMap((r) => [r.key, ...r.components]));
  const failing = files.filter((f) => keys.has(componentKey(f)));
  // Direct dependencies in either direction, not an unbounded permission to edit the whole workspace.
  for (const f of files) if (failing.some((root) => references(root.content, f) || references(f.content, root))) keys.add(componentKey(f));
  return [...keys];
}

export function compileDue(state: CompileState, now = Date.now()): boolean {
  return state.dirtyPaths.length >= COMPILE_FILE_LIMIT || (state.dirtySince !== null && now - state.dirtySince >= COMPILE_INTERVAL_MS);
}

export function applyCompileResult(
  state: CompileState,
  files: WorkspaceFile[],
  failures: DeployFailure[],
  ok: boolean,
  hash: string,
  full = false,
): CompileState {
  const keys = [...new Set(files.map(componentKey))].sort();
  const roots = ok ? [] : rootDiagnostics(failures);
  // A slice may repair its own failures; it cannot clear failures belonging to a different slice.
  const untouched = full ? [] : state.roots.filter((r) => !keys.includes(r.key) && !r.components.some((k) => keys.includes(k)));
  const merged = [...new Map([...untouched, ...roots].map((r) => [r.key, r])).values()];
  const noProgress = state.roots.length > 0 && merged.length >= state.roots.length ? state.noProgress + 1 : 0;
  const checkedFiles = { ...state.checkedFiles };
  for (const f of files) checkedFiles[f.path] = fileHash(f);
  const checkedPaths = new Set(files.map((f) => f.path));
  const dirtyPaths = full ? [] : state.dirtyPaths.filter((p) => !checkedPaths.has(p));
  return {
    ...state,
    checkedFiles,
    dirtyPaths,
    dirtySince: dirtyPaths.length ? state.dirtySince : null,
    roots: merged,
    repairKeys: repairComponents(merged, files),
    scopeKeys: keys,
    lastFailedHash: ok ? null : hash,
    noProgress,
    checks: state.checks + 1,
    stopped:
      noProgress >= 2
        ? `Stopped after two compiles without a smaller root-error set (${merged.length} roots). Staged work is preserved; repair manually and validate before resuming.`
        : null,
  };
}
