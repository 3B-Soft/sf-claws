import { type ImpactCommand, type PermissionDecision, type PermissionRefusal, PolicyRules, type UiMode, evaluatePermission, globMatch } from '@sf-claws/shared';
import type { Repos, OrgRow } from '../db/repos/index.js';

export interface PolicyViolation {
  rule: string;
  message: string;
}

/** Programmatically enforced policy (in addition to the markdown skills the models read). */
export class PolicyService {
  constructor(private repos: Repos) {}

  effective(clientId?: string | null): PolicyRules {
    const global = this.repos.policies.get('global') ?? {};
    const client = clientId ? (this.repos.policies.get(`client:${clientId}`) ?? {}) : {};
    return PolicyRules.parse({ ...global, ...client });
  }

  /** Check a component the agent wants to write/delete. */
  checkComponent(rules: PolicyRules, metadataType: string | null, fullName: string | null): PolicyViolation | null {
    if (metadataType && rules.forbiddenMetadataTypes.map((t) => t.toLowerCase()).includes(metadataType.toLowerCase())) {
      return { rule: 'forbiddenMetadataTypes', message: `Changing ${metadataType} components is not allowed by policy.` };
    }
    if (fullName) {
      for (const pat of rules.protectedComponents) {
        if (globMatch(pat, fullName))
          return { rule: 'protectedComponents', message: `"${fullName}" matches protected pattern "${pat}" and must not be modified.` };
      }
    }
    return null;
  }

  checkDeploy(rules: PolicyRules, org: OrgRow, uiMode: UiMode, componentCount: number): PolicyViolation | null {
    if (componentCount > rules.maxComponentsPerDeploy)
      return {
        rule: 'maxComponentsPerDeploy',
        message: `Deploy contains ${componentCount} components; policy allows at most ${rules.maxComponentsPerDeploy}.`,
      };
    if (org.kind === 'production' && rules.productionRequiresProMode && uiMode !== 'pro')
      return { rule: 'productionRequiresProMode', message: 'Deploying to production requires Pro mode.' };
    return null;
  }

  /**
   * The one place a command's permission is decided. Every caller goes through here — the gate, the
   * deploy request, the commit request, the staged deletion — so widening or tightening the rules
   * cannot take effect in some paths and not others.
   *
   * `subjects` is what the command acts on (see `PERMISSION_SUBJECTS`). Pass every one of them.
   */
  checkCommand(rules: PolicyRules, command: ImpactCommand, subjects: readonly string[] = []): PermissionDecision {
    return evaluatePermission({ allow: rules.impactAllowList, deny: rules.impactDenyList }, command, subjects);
  }

  checkDataChange(rules: PolicyRules): PolicyViolation | null {
    if (!rules.allowDataModification)
      return { rule: 'allowDataModification', message: 'Creating or updating records is disabled by policy. The user can do it manually in Salesforce.' };
    return null;
  }
}

export { globMatch };

/** The subject string a metadata component presents to a permission rule. */
export function componentSubject(metadataType: string | null | undefined, fullName: string | null | undefined): string {
  return `${metadataType ?? 'Unknown'}:${fullName ?? 'unknown'}`;
}

/**
 * Subjects for a deploy: one per staged component. A file with no resolved component still
 * contributes a subject, so a scoped allow rule cannot be satisfied by ignoring what it cannot name.
 */
export function deploySubjects(files: readonly { metadataType: string | null; fullName: string | null; path: string }[]): string[] {
  return [...new Set(files.map((f) => (f.metadataType || f.fullName ? componentSubject(f.metadataType, f.fullName) : `File:${f.path}`)))];
}

/**
 * What the agent is told when a command is not permitted. Deny and refuse are kept apart on
 * purpose: "an admin has explicitly forbidden this" and "nobody has permitted this" lead to
 * different next moves, and a model that is told the truth stops retrying.
 */
export function permissionRefusalText(command: string, decision: PermissionRefusal): string {
  if (decision.effect === 'deny') {
    const where = decision.subject ? ` for "${decision.subject}"` : '';
    return `REFUSED: "${command}"${where} is explicitly denied by the policy rule \`${decision.rule}\` set by your super admin. Do not retry and do not work around it; tell the user what you wanted to do and why it was blocked.`;
  }
  const where = decision.subject ? ` "${decision.subject}" is not covered by any allow rule for "${command}".` : '';
  return `REFUSED: "${command}" is not on the allow list configured by your super admin.${where} Do not retry; explain to the user and suggest they ask an admin.`;
}

/** Short form for the policy.blocked event and the audit trail. */
export function permissionBlockedMessage(command: string, decision: PermissionRefusal): string {
  if (decision.effect === 'deny') return `"${command}"${decision.subject ? ` (${decision.subject})` : ''} denied by rule ${decision.rule}.`;
  return decision.subject
    ? `"${command}" not allowed for "${decision.subject}" by this client's allow list.`
    : `"${command}" is not on the allow list for this client.`;
}
