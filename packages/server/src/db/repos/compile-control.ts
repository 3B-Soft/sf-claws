import type { Db } from '../db.js';
import { initialCompileState, normalizeComponentKey, type CompileState } from '../../agents/compile-control.js';

export class CompileControlRepo {
  constructor(private db: Db) {}
  get(sessionId: string): CompileState {
    const row = this.db.prepare('SELECT state FROM session_compile_control WHERE session_id=?').get(sessionId) as { state: string } | undefined;
    if (!row) return initialCompileState();
    const state: CompileState = JSON.parse(row.state);
    // Upgrade saved failure gates so existing sessions can repair bundle errors too.
    state.roots = state.roots.map((root) => ({ ...root, key: normalizeComponentKey(root.key), components: root.components.map(normalizeComponentKey) }));
    state.repairKeys = state.repairKeys.map(normalizeComponentKey);
    state.scopeKeys = state.scopeKeys.map(normalizeComponentKey);
    return state;
  }
  set(sessionId: string, state: CompileState): void {
    this.db
      .prepare('INSERT INTO session_compile_control (session_id, state) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET state=excluded.state')
      .run(sessionId, JSON.stringify(state));
  }
}
