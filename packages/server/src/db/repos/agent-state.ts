import type { AgentRole, AgentTask } from '@sf-claws/shared';
import type { Db } from '../db.js';
import { newId } from '../../lib/crypto.js';

export interface WorkerRecord {
  specialistId?: string;
  research?: { sourceId: string; thoroughness: string };
  id: string;
  parentId: string;
  role: AgentRole;
  objective: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  report: string;
  ok: boolean;
}
export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  message: string;
}
export interface AgentState {
  tasks: AgentTask[];
  workers: WorkerRecord[];
  messages: AgentMessage[];
}

/** One session-scoped document; synchronous transactions make claims and dependency edits atomic. */
export class AgentStateRepo {
  constructor(private db: Db) {}
  get(sessionId: string): AgentState {
    const row = this.db.prepare('SELECT state FROM session_agent_state WHERE session_id=?').get(sessionId) as { state: string } | undefined;
    return row ? JSON.parse(row.state) : { tasks: [], workers: [], messages: [] };
  }
  change<T>(sessionId: string, edit: (state: AgentState) => T): T {
    return this.db.transaction(() => {
      const state = this.get(sessionId);
      const result = edit(state);
      this.db
        .prepare('INSERT INTO session_agent_state (session_id,state) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET state=excluded.state')
        .run(sessionId, JSON.stringify(state));
      return result;
    })();
  }
  createTask(sessionId: string, input: { subject: string; description: string; activeForm?: string }): AgentTask {
    return this.change(sessionId, (state) => {
      if (state.tasks.length >= 200) throw new Error('Session task limit reached (200).');
      const task: AgentTask = { ...input, id: newId('task'), status: 'pending', owner: null, blockedBy: [], metadata: {} };
      state.tasks.push(task);
      return task;
    });
  }
  updateTask(
    sessionId: string,
    taskId: string,
    input: {
      subject?: string;
      description?: string;
      activeForm?: string;
      status?: AgentTask['status'] | 'deleted';
      owner?: string;
      metadata?: Record<string, unknown>;
      addBlocks?: string[];
      addBlockedBy?: string[];
    },
  ): AgentTask | null {
    return this.change(sessionId, (state) => {
      const task = state.tasks.find((t) => t.id === taskId);
      if (!task) throw new Error('Task not found in this session.');
      if (input.status === 'deleted') {
        state.tasks = state.tasks.filter((t) => t.id !== taskId);
        for (const t of state.tasks) t.blockedBy = t.blockedBy.filter((id) => id !== taskId);
        return null;
      }
      if (input.owner && task.owner && task.owner !== input.owner) throw new Error('Task already claimed. Clear its owner before reassigning.');
      if (input.owner && input.owner !== 'orchestrator' && !state.workers.some((w) => w.id === input.owner))
        throw new Error('Owner must be an agent ID in this session.');
      const addEdge = (id: string, dependency: string) => {
        const target = state.tasks.find((t) => t.id === id);
        if (!target || !state.tasks.some((t) => t.id === dependency)) throw new Error('Dependency task not found in this session.');
        target.blockedBy = [...new Set([...target.blockedBy, dependency])];
      };
      for (const id of input.addBlockedBy ?? []) addEdge(taskId, id);
      for (const id of input.addBlocks ?? []) addEdge(id, taskId);
      const visiting = new Set<string>();
      const visited = new Set<string>();
      const visit = (id: string) => {
        if (visiting.has(id)) throw new Error('Task dependencies must not contain a cycle.');
        if (visited.has(id)) return;
        visiting.add(id);
        for (const dep of state.tasks.find((t) => t.id === id)!.blockedBy) visit(dep);
        visiting.delete(id);
        visited.add(id);
      };
      for (const t of state.tasks) visit(t.id);
      if (input.status) task.status = input.status;
      if (input.owner !== undefined) task.owner = input.owner || null;
      for (const t of state.tasks) {
        if (
          (t.status !== 'pending' || (t.id === taskId && !!input.owner)) &&
          t.blockedBy.some((id) => state.tasks.find((d) => d.id === id)?.status !== 'completed')
        ) {
          throw new Error('Resolve dependencies before claiming, starting, or completing a task.');
        }
      }
      for (const key of ['subject', 'description', 'activeForm'] as const) if (input[key] !== undefined) task[key] = input[key];
      for (const [key, value] of Object.entries(input.metadata ?? {})) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        if (value === null) delete task.metadata[key];
        else task.metadata[key] = value;
      }
      return task;
    });
  }
  drain(sessionId: string, to: string): AgentMessage[] {
    return this.change(sessionId, (state) => {
      const messages = state.messages.filter((m) => m.to === to);
      state.messages = state.messages.filter((m) => m.to !== to);
      return messages;
    });
  }
}
