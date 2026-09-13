import { describe, it, expect } from 'vitest';
import { globMatch } from '../src/agents/policy.js';
import { makeContext } from './helpers.js';
import { parseFrontMatter } from '../src/skills/service.js';

describe('policy', () => {
  it('matches protected patterns', () => {
    expect(globMatch('yourns__*', 'yourns__Contract__c')).toBe(true);
    expect(globMatch('yourns__*', 'Account.Foo__c')).toBe(false);
    expect(globMatch('Account.*', 'Account.Renewal_Date__c')).toBe(true);
  });
  it('merges global and client overrides', () => {
    const ctx = makeContext();
    ctx.repos.policies.set('global', { forbiddenMetadataTypes: ['Profile'], minCodeCoverage: 80 }, 'u');
    ctx.repos.policies.set('client:c1', { minCodeCoverage: 90 }, 'u');
    const eff = ctx.policy.effective('c1');
    expect(eff.forbiddenMetadataTypes).toEqual(['Profile']);
    expect(eff.minCodeCoverage).toBe(90);
    expect(eff.alwaysConfirmDeploy).toBe(true);
    expect(ctx.policy.checkComponent(eff, 'Profile', 'Admin')?.rule).toBe('forbiddenMetadataTypes');
    expect(ctx.policy.checkComponent(eff, 'CustomField', 'Account.X__c')).toBeNull();
  });
  it('parses skill front matter', () => {
    const { meta, body } = parseFrontMatter('---\nname: Foo\nkind: policy\nroles: [orchestrator, reviewer]\nenabled: false\n---\n# Body');
    expect(meta).toEqual({ name: 'Foo', kind: 'policy', roles: ['orchestrator', 'reviewer'], enabled: false });
    expect(body).toBe('# Body');
  });
});
