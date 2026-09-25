import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { makeContext } from './helpers.js';

/** Seeding re-syncs an edited skill file on boot, unless an admin has edited that skill since. */
describe('skill seeding', () => {
  it('re-syncs changed files but keeps admin edits', () => {
    const ctx = makeContext();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
    const write = (f: string, body: string) => fs.writeFileSync(path.join(dir, f), `---\nkind: playbook\n---\n${body}`);
    write('a.md', 'v1');
    write('b.md', 'v1');
    ctx.skills.seedFromDir(dir);

    const b = ctx.repos.skills.bySeedFile('b.md')!;
    ctx.repos.skills.update(b.id, { content: 'admin edit', updatedBy: 'usr_admin' });

    write('a.md', 'v2');
    write('b.md', 'v2');
    ctx.skills.seedFromDir(dir);

    expect(ctx.repos.skills.bySeedFile('a.md')!.content.trim()).toBe('v2');
    expect(ctx.repos.skills.bySeedFile('b.md')!.content).toBe('admin edit');
  });
});
