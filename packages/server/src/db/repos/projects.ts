import type { SQLQueryBindings } from 'bun:sqlite';
import type { Project, Task, TaskStatus } from '@sf-claws/shared';
import { type Db, nowIso, rowToObj } from '../db.js';
import { newId } from '../../lib/crypto.js';

export class ProjectsRepo {
  constructor(private db: Db) {}
  /** Projects for one client. Scoped by construction — see listAll for the admin-only inventory. */
  list(clientId: string): Project[] {
    return this.db
      .prepare('SELECT * FROM projects WHERE client_id=? ORDER BY created_at DESC')
      .all(clientId)
      .map((r) => rowToObj<Project>(r));
  }
  /** Every client's projects. Admin inventory only; never reachable from a session. */
  listAll(): Project[] {
    return this.db
      .prepare('SELECT * FROM projects ORDER BY created_at DESC')
      .all()
      .map((r) => rowToObj<Project>(r));
  }
  byId(id: string): Project | undefined {
    return rowToObj<Project>(this.db.prepare('SELECT * FROM projects WHERE id=?').get(id));
  }
  create(input: { clientId: string; name: string; description?: string }): Project {
    const id = newId('prj');
    this.db
      .prepare('INSERT INTO projects (id, client_id, name, description, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, input.clientId, input.name, input.description ?? null, 'active', nowIso());
    return this.byId(id)!;
  }
  update(id: string, patch: Partial<{ name: string; description: string | null; status: 'active' | 'archived' }>): Project | undefined {
    const map: Record<string, string> = { name: 'name', description: 'description', status: 'status' };
    const sets: string[] = [];
    const vals: SQLQueryBindings[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !map[k]) continue;
      sets.push(`${map[k]}=?`);
      vals.push(v);
    }
    if (sets.length) this.db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id=?`).run(...vals, id);
    return this.byId(id);
  }
  delete(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id=?').run(id);
  }
}

export class TasksRepo {
  constructor(private db: Db) {}
  list(filter: { projectId?: string; orgId?: string; assigneeId?: string; status?: TaskStatus } = {}): Task[] {
    const where: string[] = [];
    const vals: SQLQueryBindings[] = [];
    if (filter.projectId) {
      where.push('project_id=?');
      vals.push(filter.projectId);
    }
    if (filter.orgId) {
      where.push('org_id=?');
      vals.push(filter.orgId);
    }
    if (filter.assigneeId) {
      where.push('assignee_id=?');
      vals.push(filter.assigneeId);
    }
    if (filter.status) {
      where.push('status=?');
      vals.push(filter.status);
    }
    // Refuse an unfiltered read: "all tasks" would cross every client in the deployment.
    if (!where.length) throw new Error('tasks.list requires at least one filter (projectId, orgId, assigneeId or status)');
    return this.db
      .prepare(`SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY updated_at DESC`)
      .all(...vals)
      .map((r) => rowToObj<Task>(r));
  }
  byId(id: string): Task | undefined {
    return rowToObj<Task>(this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id));
  }
  create(input: { projectId: string; orgId?: string | null; title: string; description?: string | null; assigneeId?: string | null }): Task {
    const id = newId('tsk');
    const now = nowIso();
    this.db
      .prepare('INSERT INTO tasks (id, project_id, org_id, title, description, status, assignee_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.projectId, input.orgId ?? null, input.title, input.description ?? null, 'open', input.assigneeId ?? null, now, now);
    return this.byId(id)!;
  }
  update(
    id: string,
    patch: Partial<{ title: string; description: string | null; status: TaskStatus; assigneeId: string | null; orgId: string | null }>,
  ): Task | undefined {
    const map: Record<string, string> = { title: 'title', description: 'description', status: 'status', assigneeId: 'assignee_id', orgId: 'org_id' };
    const sets: string[] = ['updated_at=?'];
    const vals: SQLQueryBindings[] = [nowIso()];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !map[k]) continue;
      sets.push(`${map[k]}=?`);
      vals.push(v);
    }
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id=?`).run(...vals, id);
    return this.byId(id);
  }
  delete(id: string): void {
    this.db.prepare('DELETE FROM tasks WHERE id=?').run(id);
  }
}
