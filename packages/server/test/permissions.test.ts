import { describe, it, expect } from 'vitest';
import { PolicyRules, evaluatePermission, parsePermissionRule } from '@sf-claws/shared';
import { deploySubjects } from '../src/agents/policy.js';
import { makeContext } from './helpers.js';

const rules = (allow: string[], deny: string[] = []) => ({ allow, deny });

describe('permission rule parsing', () => {
  it('reads a bare command and a scoped one', () => {
    expect(parsePermissionRule('deploy')).toEqual({ command: 'deploy', pattern: null });
    expect(parsePermissionRule('update_record(Account)')).toEqual({ command: 'update_record', pattern: 'Account' });
    expect(parsePermissionRule('  delete_component( *__c ) ')).toEqual({ command: 'delete_component', pattern: '*__c' });
  });

  it('rejects a rule that names no real command, so a typo fails at the API rather than at run time', () => {
    expect(parsePermissionRule('depoy')).toBeNull();
    expect(parsePermissionRule('update_record(')).toBeNull();
    expect(parsePermissionRule('')).toBeNull();
    expect(PolicyRules.safeParse({ impactAllowList: ['deploy', 'depoy'] }).success).toBe(false);
    expect(PolicyRules.safeParse({ impactAllowList: ['deploy', 'update_record(Account)'] }).success).toBe(true);
  });
});

describe('permission evaluation', () => {
  it('keeps the flat allow list working exactly as before', () => {
    expect(evaluatePermission(rules(['deploy', 'run_apex_tests']), 'deploy', ['CustomField:Account.X__c'])).toMatchObject({ effect: 'allow' });
    expect(evaluatePermission(rules(['deploy']), 'delete_record', ['Account'])).toMatchObject({ effect: 'refuse' });
    expect(evaluatePermission(rules([]), 'deploy')).toMatchObject({ effect: 'refuse' });
  });

  it('scopes a command to the subjects its pattern matches', () => {
    const r = rules(['update_record(Account)', 'update_record(Contact)']);
    expect(evaluatePermission(r, 'update_record', ['Account'])).toMatchObject({ effect: 'allow' });
    expect(evaluatePermission(r, 'update_record', ['Opportunity'])).toEqual({ effect: 'refuse', subject: 'Opportunity' });
    expect(evaluatePermission(rules(['delete_component(*__c)']), 'delete_component', ['CustomField:Account.Old__c'])).toMatchObject({ effect: 'allow' });
    expect(evaluatePermission(rules(['delete_component(*__c)']), 'delete_component', ['ApexClass:AccountService'])).toMatchObject({ effect: 'refuse' });
  });

  it('requires every subject to be covered, so one allowed component cannot carry the rest', () => {
    const r = rules(['deploy(CustomField:*)']);
    expect(evaluatePermission(r, 'deploy', ['CustomField:Account.A__c', 'CustomField:Account.B__c'])).toMatchObject({ effect: 'allow' });
    // The Apex class is the whole point: a partial deploy is not a safe outcome.
    expect(evaluatePermission(r, 'deploy', ['CustomField:Account.A__c', 'ApexClass:Trigger'])).toEqual({ effect: 'refuse', subject: 'ApexClass:Trigger' });
  });

  it('lets deny beat any allow, however broad', () => {
    const r = rules(['deploy', 'delete_record'], ['delete_record', 'deploy(ApexClass:*)']);
    expect(evaluatePermission(r, 'delete_record', ['Account'])).toMatchObject({ effect: 'deny', rule: 'delete_record' });
    expect(evaluatePermission(r, 'deploy', ['CustomField:Account.A__c'])).toMatchObject({ effect: 'allow' });
    expect(evaluatePermission(r, 'deploy', ['CustomField:Account.A__c', 'ApexClass:Foo'])).toEqual({
      effect: 'deny',
      rule: 'deploy(ApexClass:*)',
      subject: 'ApexClass:Foo',
    });
  });

  it('refuses a scoped rule when the subject is unknown, rather than assuming it is fine', () => {
    // Scoping a rule says "only these are acceptable". "We could not tell" is not one of them.
    expect(evaluatePermission(rules(['execute_anonymous_apex(read-only)']), 'execute_anonymous_apex', [])).toMatchObject({ effect: 'refuse' });
    expect(evaluatePermission(rules(['execute_anonymous_apex']), 'execute_anonymous_apex', [])).toMatchObject({ effect: 'allow' });
    expect(evaluatePermission(rules(['execute_anonymous_apex(read-only)']), 'execute_anonymous_apex', ['read-only'])).toMatchObject({ effect: 'allow' });
    expect(evaluatePermission(rules(['execute_anonymous_apex(read-only)']), 'execute_anonymous_apex', ['mutating'])).toMatchObject({ effect: 'refuse' });
  });

  it('ignores rules for other commands', () => {
    expect(evaluatePermission(rules(['deploy'], ['update_record(Account)']), 'deploy', ['CustomField:X'])).toMatchObject({ effect: 'allow' });
  });
});

describe('deploy subjects', () => {
  it('names every staged component once, and does not silently drop an unidentified file', () => {
    expect(
      deploySubjects([
        { metadataType: 'CustomField', fullName: 'Account.A__c', path: 'objects/Account/fields/A__c.field-meta.xml' },
        { metadataType: 'CustomField', fullName: 'Account.A__c', path: 'dup' },
        { metadataType: null, fullName: null, path: 'notes/scratch.txt' },
      ]),
    ).toEqual(['CustomField:Account.A__c', 'File:notes/scratch.txt']);
  });
});

describe('policy service', () => {
  it('evaluates through the client-merged rules', () => {
    const ctx = makeContext();
    ctx.repos.policies.set('global', { impactAllowList: ['deploy', 'update_record'] }, 'u');
    ctx.repos.policies.set('client:c1', { impactDenyList: ['update_record(Account)'] }, 'u');
    const eff = ctx.policy.effective('c1');
    expect(ctx.policy.checkCommand(eff, 'update_record', ['Contact']).effect).toBe('allow');
    expect(ctx.policy.checkCommand(eff, 'update_record', ['Account']).effect).toBe('deny');
    expect(ctx.policy.checkCommand(eff, 'delete_record', ['Contact']).effect).toBe('refuse');
  });
});
