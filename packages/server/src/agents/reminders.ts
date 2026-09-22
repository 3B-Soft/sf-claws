/**
 * System reminders.
 *
 * Standing instructions in the system prompt decay: by step 30 of a validation loop the model is
 * reasoning about XML, not about the rule it read once at the start. A reminder is appended to a
 * tool result at the moment it becomes relevant — "the workspace changed since your last clean
 * validation", "you are the reviewer, do not edit" — which is cheap, timely, and does not touch the
 * cacheable prefix.
 *
 * Keep them short and actionable, and only emit one when the state actually warrants it: reminders
 * that fire constantly get tuned out exactly like a prompt line does. That is why several of these
 * are gated on "since the last time this fired" rather than on state alone: the org-limit warning
 * fires once per threshold crossing, the todo nudge once per drift window, the plan and reviewer
 * reminders in full once and then as one line every few calls.
 */
import type { AgentRole } from '@sf-claws/shared';

export interface ReminderInput {
  role: AgentRole;
  /** Tool that just ran. */
  tool: string;
  /** Tool calls this agent has made since its last todo_write. */
  callsSinceTodoWrite: number;
  /** Tool calls since the todo nudge last fired (so it does not fire on every call past the threshold). */
  callsSinceTodoReminder: number;
  /** Workspace changed after the most recent successful validation. */
  workspaceDirtyAfterCleanValidation: boolean;
  /** Staged files exist but no documentation has been written this turn. */
  stagedWithoutDocs: boolean;
  orgIsProduction: boolean;
  /** Org limit warning text, only when it differs from the last one this turn reminded about. */
  orgLimitWarning: string | null;
  hasOpenTodos: boolean;
  /** Plan mode is on and no plan is approved yet (orchestrator). */
  planPending: boolean;
  /** Tool calls this agent has made so far in its run (1 = this is the first). */
  callsThisRun: number;
  /** A spend ceiling crossed a new fraction (0.5, 0.75, 0.9) with this call, or null. */
  budget: { scope: 'turn' | 'session' | 'client_month'; spentUsd: number; limitUsd: number } | null;
}

/** How many tool calls an orchestrator may make before we nudge it about the todo list. */
const TODO_DRIFT_THRESHOLD = 8;
/** Calls between the sparse one-line plan / reviewer reminders. */
const SPARSE_REMINDER_EVERY = 6;

export function buildReminders(i: ReminderInput): string[] {
  const out: string[] = [];

  // A stale "clean validation" is the most dangerous state in the product: it is how a deploy of
  // unvalidated metadata would happen.
  if (i.workspaceDirtyAfterCleanValidation && (i.tool === 'request_deploy' || i.tool.startsWith('write_') || i.tool.startsWith('edit_'))) {
    out.push(
      'The workspace has changed since the last successful validation. Run validate_deployment again before requesting a deploy — the earlier clean result no longer covers these files.',
    );
  }

  if (i.orgIsProduction && MUTATING_TOOLS.has(i.tool)) {
    out.push(
      'This org is PRODUCTION. Explain the blast radius (which users, profiles and automations are affected) in plain language before asking the user to confirm anything.',
    );
  }

  // Reviewers drift from "review" to "fix": being helpful is the default behaviour we must suppress.
  // Full text on the first call, then a single line every few calls — a per-turn cadence is more
  // reliable than tying it to one tool name.
  if (i.role === 'reviewer' || i.role === 'verify') {
    if (i.callsThisRun === 1) {
      out.push(
        'You are reviewing, not building. You hold no write tools on purpose: an independent check that edits is no longer independent. Report findings with evidence and a concrete fix for the builder; do not attempt to change any file, and end with a VERDICT line.',
      );
    } else if (i.callsThisRun % SPARSE_REMINDER_EVERY === 0) {
      out.push('Reviewer: read-only. Findings with evidence, then VERDICT: PASS | FAIL | PARTIAL.');
    }
  }

  // Plan mode: the full rules are in the prompt; while a plan is still pending, one line per
  // drift window keeps the gate from being fought.
  if (i.role === 'orchestrator' && i.planPending && i.callsThisRun > 1 && i.callsThisRun % SPARSE_REMINDER_EVERY === 0) {
    out.push('No approved plan yet; staging tools are refused. Finish investigating, then end with ask_user or submit_plan.');
  }

  if (i.role === 'orchestrator' && i.hasOpenTodos && i.callsSinceTodoWrite >= TODO_DRIFT_THRESHOLD && i.callsSinceTodoReminder >= TODO_DRIFT_THRESHOLD) {
    out.push(
      `${i.callsSinceTodoWrite} tool calls since you last updated the todo list. The user tracks progress there — mark what is done and what you are working on now.`,
    );
  }

  if (i.orgLimitWarning) {
    out.push(`Org limits are under pressure (${i.orgLimitWarning}). Be economical with API calls and tell the user if the remaining work is API-heavy.`);
  }

  if (i.budget) {
    const pct = Math.round((i.budget.spentUsd / i.budget.limitUsd) * 100);
    out.push(
      `Spend is at ${pct}% of the ${describeScope(i.budget.scope)} ceiling ($${i.budget.spentUsd.toFixed(2)} of $${i.budget.limitUsd.toFixed(2)}). The harness stops the run before a call that would cross it: finish the most valuable work first and write findings down now.`,
    );
  }

  if (i.stagedWithoutDocs && i.tool === 'request_deploy') {
    out.push(
      'Remember that this session still needs documentation (write_documentation or a doc_writer sub-agent) before it is finished, whatever the user decides about deploying.',
    );
  }

  return out;
}

/** Fractions of a ceiling at which the budget reminder fires, once each per turn. */
export const BUDGET_REMINDER_FRACTIONS = [0.5, 0.75, 0.9];

function describeScope(scope: 'turn' | 'session' | 'client_month'): string {
  return scope === 'turn' ? 'per-turn' : scope === 'session' ? 'session' : 'monthly client';
}

const MUTATING_TOOLS = new Set([
  'request_deploy',
  'execute_anonymous_apex',
  'create_record',
  'update_record',
  'delete_record',
  'delete_component',
  'run_apex_tests',
]);

/**
 * Wrap reminders in the tag the prompt tells agents to treat as system-authored. The prompt also
 * says never to mention a reminder to the user, so the tag carries no repeat of that rule.
 */
export function formatReminders(reminders: string[]): string {
  if (!reminders.length) return '';
  return `\n\n<system-reminder>\n${reminders.map((r) => `- ${r}`).join('\n')}\n</system-reminder>`;
}
