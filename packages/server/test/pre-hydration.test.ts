import { describe, it, expect, vi } from 'vitest';
import { FactCache, OrgReadLimiter } from '../src/agents/fact-cache.js';
import { preHydrate, hydrationPrompt, hydrationTargets, inspectGit } from '../src/agents/pre-hydration.js';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeContext, seedClientOrgUser, FakeProvider, text, toolCall, disablePlanMode, waitForIdle } from './helpers.js';

describe('shared verified facts', () => {
  it('coalesces concurrent misses, isolates keys, evicts bounds, and never caches errors', async () => {
    const cache = new FactCache(60_000, 1024, 2);
    const read = vi.fn(async () => ({ fields: ['A'] }));
    const [first, second] = await Promise.all([
      cache.read('tenant1:org:principal:version:revision:Account', read),
      cache.read('tenant1:org:principal:version:revision:Account', read),
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    first.fields.push('mutated');
    expect(second.fields).toEqual(['A']);
    await cache.read('tenant2:org:principal:version:revision:Account', read);
    expect(read).toHaveBeenCalledTimes(2);
    const fail = vi.fn(async () => {
      throw new Error('forbidden');
    });
    await expect(cache.read('bad', fail)).rejects.toThrow('forbidden');
    await expect(cache.read('bad', fail)).rejects.toThrow('forbidden');
    expect(fail).toHaveBeenCalledTimes(2);
    await cache.read('third', read);
    await cache.read('tenant1:org:principal:version:revision:Account', read);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it('limits aggregate org reads to three even across concurrent hydration jobs', async () => {
    const limiter = new OrgReadLimiter(3);
    let active = 0;
    let maximum = 0;
    await Promise.all(
      Array.from({ length: 12 }, () =>
        limiter.run('org', async () => {
          maximum = Math.max(maximum, ++active);
          await new Promise((r) => setTimeout(r, 1));
          active--;
        }),
      ),
    );
    expect(maximum).toBe(3);
  });

  it('keeps live schema warm across workspace edits and invalidates on org revision', async () => {
    const ctx = makeContext();
    const { org, user } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    const loader = vi.fn(async () => ({ name: 'Account', fields: [] }));
    await ctx.runtime.readFact(session.id, 'describe:Account', loader);
    ctx.runtime.noteWorkspaceChange(session.id, 'classes/A.cls');
    await ctx.runtime.readFact(session.id, 'describe:Account', loader);
    expect(loader).toHaveBeenCalledTimes(1);
    ctx.repos.harness.invalidate(org.id);
    await ctx.runtime.readFact(session.id, 'describe:Account', loader);
    expect(loader).toHaveBeenCalledTimes(2);
    ctx.db.close();
  });
});

describe('deterministic pre-hydration', () => {
  it('inspects status, diff and history without altering a dirty Git checkout, and refuses symlinks', async () => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'sf-claws-hydration-')));
    const git = (args: string[]) => promisify(execFile)('git', args, { cwd: directory });
    try {
      await git(['init']);
      await git(['config', 'user.name', 'Test']);
      await git(['config', 'user.email', 'test@example.invalid']);
      await mkdir(path.join(directory, 'classes'));
      const filename = path.join(directory, 'classes', 'A.cls');
      await writeFile(filename, 'public class A {}');
      await git(['add', 'classes/A.cls']);
      await git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'baseline']);
      await writeFile(filename, 'public class A { Account value; }');
      await writeFile(path.join(directory, 'classes', 'B.cls'), 'public class B {}');
      const before = (await git(['status', '--porcelain'])).stdout;
      const snapshot = await inspectGit(directory);
      expect(snapshot.changed).toEqual(['classes/A.cls', 'classes/B.cls']);
      expect(snapshot.log).toContain('baseline');
      expect(snapshot.head).toMatch(/^[a-f0-9]{40}$/);
      expect(snapshot.files).toHaveLength(2);
      expect((await git(['status', '--porcelain'])).stdout).toBe(before);
      expect(await readFile(filename, 'utf8')).toContain('Account');
      await symlink(directory, path.join(directory, 'alias'));
      await expect(inspectGit(path.join(directory, 'alias'))).rejects.toThrow(/local Git checkout/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('selects bounded, explicit targets without global discovery', () => {
    const targets = hydrationTargets('Read object Account and ApexClass Existing', { objectApiName: 'Contact' }, [
      { path: 'classes/Helper.cls', content: 'SELECT Id FROM Order__c' },
    ]);
    expect(targets.map((t) => t.name)).toEqual(expect.arrayContaining(['Account', 'Contact', 'Helper', 'Order__c', 'Existing']));
    expect(hydrationTargets(Array.from({ length: 40 }, (_, i) => `object A${i}`).join(' '), {}, [])).toHaveLength(8);
  });

  it('runs before the first model call, injects evidence, and persists it outside history', async () => {
    const events: string[] = [];
    const describe = vi.fn(async () => {
      events.push('describe');
      return { name: 'Account', fields: [{ name: 'Name', type: 'string' }] };
    });
    const provider = new FakeProvider([
      (req) => {
        events.push('model');
        expect(req.system).toContain('Persisted context bundle');
        expect(req.system).toContain('describe:Account');
        return text('Done');
      },
    ]);
    const ctx = makeContext({ provider, sf: { describe } });
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual', pageContext: { objectApiName: 'Account' } });
    ctx.runtime.startTurn(session.id, user.id, 'Inspect Name on object Account');
    await waitForIdle(ctx, session.id);
    expect(events).toEqual(['describe', 'model']);
    const bundle = ctx.repos.harness.hydration(session.id)!;
    expect(bundle.entries.find((e) => e.source === 'describe')?.status).toBe('verified');
    ctx.repos.messages.replace(session.id, 'orchestrator', []);
    expect(hydrationPrompt(ctx, session.id)).toContain(bundle.id);
    ctx.repos.harness.invalidate(org.id);
    expect(hydrationPrompt(ctx, session.id)).toContain('stale');
    ctx.db.close();
  });

  it('records unavailable vs absent and bounds second-pass discovery', async () => {
    const ctx = makeContext({
      sf: {
        describe: async () => {
          throw new Error('INSUFFICIENT_ACCESS');
        },
        query: async () => ({ records: [], totalSize: 0, done: true, columns: [] }),
      },
    });
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    const bundle = await preHydrate(ctx, session.id, 'object Private__c ApexClass Missing');
    expect(bundle.entries.find((e) => e.source === 'describe')?.status).toBe('unavailable');
    expect(bundle.entries.find((e) => e.source === 'tooling')?.status).toBe('absent');
    await preHydrate(ctx, session.id, 'object Other__c', true);
    await expect(preHydrate(ctx, session.id, 'object More__c', true)).rejects.toThrow(/pass limit/);
    ctx.db.close();
  });

  it('refuses staging when an original lookup fails instead of pretending the file is new', async () => {
    const provider = new FakeProvider([() => toolCall('write_workspace_file', { path: 'classes/A.cls', content: 'public class A {}' }), () => text('Blocked')]);
    const ctx = makeContext({
      provider,
      sf: {
        readComponent: async () => {
          throw new Error('INSUFFICIENT_ACCESS');
        },
      },
    });
    disablePlanMode(ctx);
    const { user, org } = await seedClientOrgUser(ctx);
    const session = ctx.runtime.createSession({ userId: user.id, orgId: org.id, uiMode: 'visual' });
    ctx.runtime.startTurn(session.id, user.id, 'make a change');
    await waitForIdle(ctx, session.id);
    expect(ctx.repos.workspace.list(session.id)).toEqual([]);
    const results = ctx.repos.events.listAfter(session.id).filter((e) => e.type === 'tool.result');
    expect(JSON.stringify(results)).toContain('Nothing staged');
    ctx.db.close();
  });
});
