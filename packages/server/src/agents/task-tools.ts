import { z } from 'zod';
import type { ToolDef, ToolContext } from './tools.js';
import {
  TASK_CREATE_PROMPT,
  TASK_GET_PROMPT,
  TASK_LIST_PROMPT,
  TASK_UPDATE_PROMPT,
  TASK_OUTPUT_PROMPT,
  TASK_STOP_PROMPT,
  SEND_MESSAGE_PROMPT,
  BRIEF_PROMPT,
} from './tool-prompts.js';
import { newId } from '../lib/crypto.js';

const str = z.string().min(1).max(16000);
const create = z.object({ subject: str.max(300), description: str, activeForm: str.max(300).optional() });
const update = z.object({
  taskId: str,
  subject: str.max(300).optional(),
  description: str.optional(),
  activeForm: str.max(300).optional(),
  status: z.enum(['pending', 'in_progress', 'completed', 'deleted']).optional(),
  owner: z.string().max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  addBlocks: z.array(str).max(200).optional(),
  addBlockedBy: z.array(str).max(200).optional(),
});
const get = z.object({ taskId: str });
const output = z.object({ agentId: str, block: z.boolean().default(false), timeoutMs: z.number().int().min(0).max(60000).default(30000) });
const stop = z.object({ agentId: str });
const message = z.object({ to: str, message: str, resume: z.boolean().default(false) });
const brief = z.object({ message: str, status: z.enum(['normal', 'proactive']).default('normal'), attachments: z.array(str).max(10).default([]) });
const result = (value: unknown) => ({ text: JSON.stringify(value), output: value });
/** Project the task board into the existing persistent checklist and SSE UI. */
function publishTasks(ctx: ToolContext) {
  const tasks = ctx.app.repos.agentState.get(ctx.session.id).tasks;
  const taskIds = new Set(tasks.map((t) => t.id));
  const legacy = ctx.app.repos.todos.get(ctx.session.id).filter((t) => !t.id.startsWith('task_') && !taskIds.has(t.id));
  const items = [
    ...legacy,
    ...tasks.map((t) => ({
      id: t.id,
      content: t.subject,
      activeForm: t.activeForm,
      status: t.status !== 'completed' && typeof t.metadata.blocker === 'string' && t.metadata.blocker ? ('blocked' as const) : t.status,
      ownerAgentId: t.owner,
    })),
  ];
  ctx.app.repos.todos.set(ctx.session.id, items, ctx.agent.id);
  ctx.runtime.bus.emit(ctx.session.id, { type: 'todo.updated', agentId: ctx.agent.id, items });
}
function detail(ctx: ToolContext, id?: string) {
  const tasks = ctx.app.repos.agentState.get(ctx.session.id).tasks;
  const project = (task: (typeof tasks)[number]) => ({
    ...task,
    blockedBy: task.blockedBy.filter((dep) => tasks.find((t) => t.id === dep)?.status !== 'completed'),
    blocks: tasks.filter((t) => t.blockedBy.includes(task.id)).map((t) => t.id),
  });
  if (id) {
    const task = tasks.find((t) => t.id === id);
    if (!task) throw new Error('Task not found in this session.');
    return project(task);
  }
  return tasks.map(project);
}
export const TASK_TOOLS: ToolDef[] = [
  {
    name: 'task_create',
    description: TASK_CREATE_PROMPT,
    roles: 'all',
    readOnly: false,
    inputSchema: z.toJSONSchema(create, { io: 'input' }),
    run: async (input, ctx) => {
      const task = ctx.app.repos.agentState.createTask(ctx.session.id, create.parse(input));
      publishTasks(ctx);
      return result(task);
    },
  },
  {
    name: 'task_get',
    description: TASK_GET_PROMPT,
    roles: 'all',
    readOnly: true,
    concurrencySafe: true,
    earlyStart: false,
    inputSchema: z.toJSONSchema(get, { io: 'input' }),
    run: async (input, ctx) => result(detail(ctx, get.parse(input).taskId)),
  },
  {
    name: 'task_list',
    description: TASK_LIST_PROMPT,
    roles: 'all',
    readOnly: true,
    concurrencySafe: true,
    earlyStart: false,
    inputSchema: z.toJSONSchema(z.object({})),
    run: async (_input, ctx) => result(detail(ctx)),
  },
  {
    name: 'task_update',
    description: TASK_UPDATE_PROMPT,
    roles: 'all',
    readOnly: false,
    inputSchema: z.toJSONSchema(update, { io: 'input' }),
    run: async (input, ctx) => {
      const { taskId, ...patch } = update.parse(input);
      const task = ctx.app.repos.agentState.updateTask(ctx.session.id, taskId, patch);
      publishTasks(ctx);
      return result(task);
    },
  },
  {
    name: 'task_output',
    description: TASK_OUTPUT_PROMPT,
    roles: 'all',
    readOnly: true,
    concurrencySafe: true,
    earlyStart: false,
    inputSchema: z.toJSONSchema(output, { io: 'input' }),
    run: async (input, ctx) => {
      const p = output.parse(input);
      return result(await ctx.runtime.workerOutput(ctx.session.id, p.agentId, p.block ? p.timeoutMs : 0, ctx.signal));
    },
  },
  {
    name: 'task_stop',
    description: TASK_STOP_PROMPT,
    roles: ['orchestrator'],
    readOnly: false,
    inputSchema: z.toJSONSchema(stop, { io: 'input' }),
    run: async (input, ctx) => result(ctx.runtime.stopWorker(ctx.session.id, ctx.agent.id, stop.parse(input).agentId)),
  },
  {
    name: 'send_message',
    description: SEND_MESSAGE_PROMPT,
    roles: 'all',
    readOnly: false,
    inputSchema: z.toJSONSchema(message, { io: 'input' }),
    run: async (input, ctx) => {
      const p = message.parse(input);
      return result(
        await ctx.runtime.sendAgentMessage(
          ctx.session.id,
          ctx.agent.id,
          p.to === 'parent' ? (ctx.agent.parentId ?? 'orchestrator') : p.to,
          p.message,
          p.resume,
        ),
      );
    },
  },
  {
    name: 'brief',
    description: BRIEF_PROMPT,
    roles: ['orchestrator'],
    readOnly: false,
    inputSchema: z.toJSONSchema(brief, { io: 'input' }),
    run: async (input, ctx) => {
      const p = brief.parse(input);
      for (const path of p.attachments)
        if (!ctx.app.repos.workspace.list(ctx.session.id).some((f) => f.path === path)) throw new Error(`Attachment is not a staged workspace path: ${path}`);
      const text = p.message + (p.attachments.length ? '\n\nAttachments:\n' + p.attachments.map((path) => `- ${path}`).join('\n') : '');
      ctx.runtime.bus.emit(ctx.session.id, {
        type: 'assistant.message',
        agentId: ctx.agent.id,
        role: ctx.agent.role,
        messageId: newId('brief'),
        text,
        status: p.status,
        attachments: p.attachments,
      });
      return result({ delivered: true, status: p.status, attachments: p.attachments });
    },
  },
];
