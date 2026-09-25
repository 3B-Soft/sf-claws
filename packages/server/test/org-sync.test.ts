import { describe, it, expect } from 'vitest';
import { DEFAULT_PACKAGE_XML } from '@sf-claws/shared';
import { diffOrgWithBranch, gitBlobSha } from '../src/github/org-sync.js';
import { parsePackageXml } from '../src/salesforce/metadata-xml.js';

const root = 'force-app/main/default';
const cls = (body: string) => ({ path: `classes/${body}.cls`, content: `public class ${body} {}\n` });

/** Just the services the diff touches: an org retrieve and a branch tree with blob reads. */
function fakeCtx(org: { path: string; content: string }[], branch: Record<string, string> | null) {
  const blobs = new Map(Object.entries(branch ?? {}).map(([p, c]) => [gitBlobSha(Buffer.from(c)), c]));
  return {
    repos: { orgs: { byId: () => ({ id: 'o1', clientId: 'c1', label: 'Prod' }) } },
    sf: { retrieve: async () => org },
    github: {
      repoFor: () => ({ sourceRoot: root }),
      treeShas: async () => (branch ? new Map(Object.entries(branch).map(([p, c]) => [`${root}/${p}`, gitBlobSha(Buffer.from(c))])) : null),
      blob: async (_: string, sha: string) => Buffer.from(blobs.get(sha)!),
    },
  } as any;
}

const req = { orgId: 'o1', branch: 'main', packageXml: DEFAULT_PACKAGE_XML };

describe('org ↔ branch diff', () => {
  it('matches git’s own blob sha', () => {
    expect(gitBlobSha(Buffer.from('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('parses the default manifest', () => {
    const types = parsePackageXml(DEFAULT_PACKAGE_XML);
    expect(types.find((t) => t.type === 'CustomObject')?.members).toContain('Account');
    expect(() => parsePackageXml('<Package/>')).toThrow(/no <types>/);
  });

  it('classifies added, modified, removed and whitespace-only files', async () => {
    const same = cls('Same');
    const org = [
      same,
      cls('New'),
      { path: 'classes/Changed.cls', content: 'public class Changed { Integer x; }\n' },
      { path: 'classes/Crlf.cls', content: 'a\nb\n' },
    ];
    const branch = {
      [same.path]: same.content,
      'classes/Changed.cls': 'public class Changed {}\n',
      'classes/Crlf.cls': 'a  \r\nb\r\n',
      'classes/Gone.cls': 'public class Gone {}\n',
      'reports/Out/Of/Scope.report-meta.xml': '<x/>',
    };
    const { diff } = await diffOrgWithBranch(fakeCtx(org, branch), 'c1', req);
    expect(diff.identical).toBe(2);
    expect(diff.files.map((f) => [f.path.slice(root.length + 1), f.status])).toEqual([
      ['classes/Changed.cls', 'modified'],
      ['classes/Gone.cls', 'removed'],
      ['classes/New.cls', 'added'],
    ]);
    expect(diff.files[0].patch).toContain('+public class Changed { Integer x; }');
  });

  it('treats a missing branch as empty', async () => {
    const { diff } = await diffOrgWithBranch(fakeCtx([cls('A')], null), 'c1', req);
    expect(diff.branchExists).toBe(false);
    expect(diff.files[0].status).toBe('added');
  });
});
