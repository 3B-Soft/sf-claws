/**
 * Permission rules: the allow and deny lists that decide whether an agent may even attempt a
 * command that touches a Salesforce org.
 *
 * A rule is a command name, optionally scoped to a subject pattern:
 *
 *   deploy                      every deploy
 *   update_record(Account)      updates to Account records, and nothing else
 *   delete_component(*__c)      deleting custom components only
 *   execute_anonymous_apex(read-only)
 *
 * The pattern is a glob over the command's *subjects* — what the command acts on. Each command
 * defines its own subjects (see `PERMISSION_SUBJECTS`), so an admin writing a rule knows what they
 * are matching against without reading the code.
 *
 * Evaluation order, and the reasoning behind it:
 *
 * 1. **Deny wins.** A deny rule matching any one subject stops the command, even if an allow rule
 *    covers the rest. Half a batch is not a safe outcome.
 * 2. **Every subject must be allowed.** A deploy of five components needs all five covered. Any
 *    other reading lets one allowed component smuggle four unreviewed ones in beside it.
 * 3. **Otherwise refuse.** A command nobody mentioned is not permitted.
 *
 * A command whose subjects cannot be determined (an empty subject list) needs an *unscoped* allow
 * rule. Scoping a rule is a statement that only certain subjects are acceptable, and "we could not
 * tell what this acts on" is not one of them.
 */
import { z } from 'zod';

/** Commands that can change (or heavily load) a Salesforce org. Every one is gated by a permission rule + user approval. */
export const ImpactCommand = z.enum([
  'deploy', // real metadata deploy (after clean validation)
  'execute_anonymous_apex', // run anonymous Apex
  'create_record',
  'update_record',
  'delete_record',
  'delete_component', // destructive metadata change (staged, executed at deploy)
  'run_apex_tests', // runs tests in the org
  'soql_query_tooling', // tooling API queries (read, but heavier); listed so admins can restrict
  'github_commit',
  'set_trace_flag', // creates/extends a TraceFlag + DebugLevel so Apex logs are captured
  'flow_set_active_version', // activates/deactivates a Flow version (changes live automation)
]);
export type ImpactCommand = z.infer<typeof ImpactCommand>;

/** Case-insensitive glob where `*` matches any run of characters. Everything else is literal. */
export function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(
    `^${pattern
      .split('*')
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
    'i',
  );
  return re.test(value);
}

export interface ParsedPermissionRule {
  command: ImpactCommand;
  /** null for an unscoped rule (the whole command). */
  pattern: string | null;
}

const RULE_SHAPE = /^([a-z_]+)(?:\(\s*(.+?)\s*\))?$/;

/** Parse `command` or `command(pattern)`. Returns null when the rule is malformed or unknown. */
export function parsePermissionRule(rule: string): ParsedPermissionRule | null {
  const m = RULE_SHAPE.exec(rule.trim());
  if (!m) return null;
  const parsed = ImpactCommand.safeParse(m[1]);
  if (!parsed.success) return null;
  return { command: parsed.data, pattern: m[2] ?? null };
}

/** A rule an admin can put on the allow or deny list. Validated so a typo fails at the API, not at run time. */
export const PermissionRule = z.string().refine((r) => parsePermissionRule(r) !== null, {
  message: 'Expected a command name, optionally scoped: e.g. "deploy" or "update_record(Account)".',
});
export type PermissionRule = z.infer<typeof PermissionRule>;

/** What each command's subject strings look like, so the admin console can explain a rule's scope. */
export const PERMISSION_SUBJECTS: Record<ImpactCommand, string> = {
  deploy: 'MetadataType:FullName, one per component in the deploy',
  execute_anonymous_apex: '"mutating" or "read-only"',
  create_record: 'the sObject name, e.g. Account',
  update_record: 'the sObject name, e.g. Account',
  delete_record: 'the sObject name, e.g. Account',
  delete_component: 'MetadataType:FullName',
  run_apex_tests: 'each test class name',
  soql_query_tooling: 'the Tooling object queried, e.g. ApexClass',
  github_commit: 'owner/repo#branch',
  set_trace_flag: 'the traced user id, or "self" for the running integration user',
  flow_set_active_version: 'the flow developer name',
};

export type PermissionDecision =
  | { effect: 'allow'; rule: string }
  /** An explicit deny rule matched. The admin said no to this specifically. */
  | { effect: 'deny'; rule: string; subject: string | null }
  /** Nothing on the allow list covers it. `subject` names the one that fell through, when there was one. */
  | { effect: 'refuse'; subject: string | null };

/** A decision that stops the command. Narrowing to this is what makes a refusal path unmissable. */
export type PermissionRefusal = Exclude<PermissionDecision, { effect: 'allow' }>;

function rulesFor(list: readonly string[], command: ImpactCommand): ParsedPermissionRule[] {
  return list.map(parsePermissionRule).filter((r): r is ParsedPermissionRule => r !== null && r.command === command);
}

/**
 * Decide whether `command` may run against `subjects`. Pass every subject the command will touch;
 * an empty list means the command has no meaningful subject (see the module comment).
 */
export function evaluatePermission(
  lists: { allow: readonly string[]; deny: readonly string[] },
  command: ImpactCommand,
  subjects: readonly string[] = [],
): PermissionDecision {
  for (const rule of rulesFor(lists.deny, command)) {
    if (rule.pattern === null) return { effect: 'deny', rule: formatRule(rule), subject: null };
    const hit = subjects.find((s) => globMatch(rule.pattern!, s));
    if (hit !== undefined) return { effect: 'deny', rule: formatRule(rule), subject: hit };
  }

  const allow = rulesFor(lists.allow, command);
  if (!allow.length) return { effect: 'refuse', subject: null };

  const unscoped = allow.find((r) => r.pattern === null);
  if (unscoped) return { effect: 'allow', rule: formatRule(unscoped) };
  if (!subjects.length) return { effect: 'refuse', subject: null };

  const uncovered = subjects.find((s) => !allow.some((r) => globMatch(r.pattern!, s)));
  if (uncovered !== undefined) return { effect: 'refuse', subject: uncovered };
  return { effect: 'allow', rule: allow.map(formatRule).join(', ') };
}

export function formatRule(rule: ParsedPermissionRule): string {
  return rule.pattern === null ? rule.command : `${rule.command}(${rule.pattern})`;
}

/** True when any rule in the list mentions this command at all — used to decide UI affordances. */
export function mentionsCommand(list: readonly string[], command: ImpactCommand): boolean {
  return rulesFor(list, command).length > 0;
}
