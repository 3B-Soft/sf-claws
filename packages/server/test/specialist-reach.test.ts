import { describe, it, expect } from 'vitest';
import { AgentRole } from '@sf-claws/shared';
import { toolsForRole } from '../src/agents/tools.js';

/**
 * An admin-defined specialist runs on a base role and gets that role's tools — its instructions are
 * appended to the role prompt, never substituted for it. The promise a client is owed is that no
 * text an admin writes can hand a specialist reach its base role does not already have, so the
 * tools that change an org or talk to the outside world must stay out of every delegatable role.
 */
const DELEGATABLE = AgentRole.options.filter((r) => r !== 'orchestrator' && r !== 'summarizer');

/** Only the lead agent, which is the one the user is actually talking to, may reach these. */
const LEAD_ONLY = [
  'request_deploy',
  'commit_to_github',
  'create_record',
  'update_record',
  'delete_record',
  'run_subagent',
  'consult_specialist',
  'update_task',
];

describe('specialist reach', () => {
  it('gives no delegatable base role the lead agent-only tools', () => {
    for (const role of DELEGATABLE) {
      const names = toolsForRole(role).map((t) => t.name);
      for (const forbidden of LEAD_ONLY) expect(names, `${role} must not hold ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('lets no investigating role stage, delete or deploy metadata', () => {
    // The reviewer legitimately validates and runs tests — both hit the org without changing it.
    // Staging and destructive change belong to the builders and the lead agent alone.
    const BUILD_ONLY = ['write_workspace_file', 'edit_workspace_file', 'delete_workspace_file', 'delete_component'];
    for (const role of ['analyst', 'reviewer', 'researcher', 'doc_writer'] as const) {
      const names = toolsForRole(role).map((t) => t.name);
      for (const forbidden of BUILD_ONLY) expect(names, `${role} must not hold ${forbidden}`).not.toContain(forbidden);
    }
  });
});
