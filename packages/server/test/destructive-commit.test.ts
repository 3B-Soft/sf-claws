import { describe, it, expect } from 'vitest';
import { makeContext, seedClientOrgUser, disablePlanMode, disableReviewerGate } from './helpers.js';
import type { CommitFile } from '../src/github/service.js';

/**
 * Review defect 28: a component staged for deletion (delete_component) is recorded under a
 * synthetic `__destructive__/Type/FullName` marker path, not the file's real location in the
 * repo. Committing that marker path verbatim left the actual component file behind on every
 * deletion, so the repository silently drifted from the org. `executeCommit` must resolve the
 * real SFDX source path for the deleted component and delete that instead.
 */
describe('destructive changes reach the commit', () => {
  it('deletes the real source path for a staged component deletion, not the marker path', async () => {
    const ctx = makeContext();
    disablePlanMode(ctx);
    disableReviewerGate(ctx);
    const { user, client, org } = await seedClientOrgUser(ctx);
    ctx.repos.github.upsert(client.id, {
      owner: 'acme',
      repo: 'sfdx',
      defaultBranch: 'main',
      sourceRoot: 'force-app/main/default',
      docsRoot: 'docs/harness',
      commitStrategy: 'direct',
      branchPrefix: 'harness/',
      tokenEnc: ctx.secrets.encryptFor(client.id, 'ghp_test'),
    });
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    ctx.repos.sessions.update(session.id, { branchName: 'main' });

    // Stage a deletion the way delete_component does: a marker path carrying the real
    // metadataType/fullName, action 'deleted'.
    ctx.repos.workspace.upsert(session.id, {
      path: '__destructive__/CustomField/Account.Old__c',
      content: '',
      original: null,
      metadataType: 'CustomField',
      fullName: 'Account.Old__c',
      action: 'deleted',
    });

    let committed: CommitFile[] = [];
    (ctx as any).github = {
      repoFor: () => ctx.repos.github.byClient(client.id)!,
      commit: async (_clientId: string, _branch: string, files: CommitFile[]) => {
        committed = files;
        return { sha: 'abc1234', url: 'https://github.com/acme/sfdx/commit/abc1234', filesChanged: files.length };
      },
    };

    const result = await ctx.runtime.executeCommit(session.id, user.id, 'Remove Old field', false, { confirmedBy: user.id });
    expect(result.sha).toBe('abc1234');

    const deletion = committed.find((f) => f.content === null);
    expect(deletion).toBeDefined();
    expect(deletion!.path).toBe('force-app/main/default/objects/Account/fields/Old__c.field-meta.xml');
    expect(committed.some((f) => f.path.includes('__destructive__'))).toBe(false);
  });
});
