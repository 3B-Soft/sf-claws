import type { Db } from '../db.js';
import { initialCompileState, type CompileState } from '../../agents/compile-control.js';

export class CompileControlRepo {
  constructor(private db: Db) {}
  get(sessionId: string): CompileState {
    const row = this.db.prepare('SELECT state FROM session_compile_control WHERE session_id=?').get(sessionId) as { state: string } | undefined;
    return row ? JSON.parse(row.state) : initialCompileState();
  }
  set(sessionId: string, state: CompileState): void {
    this.db
      .prepare('INSERT INTO session_compile_control (session_id, state) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET state=excluded.state')
      .run(sessionId, JSON.stringify(state));
  }
}
