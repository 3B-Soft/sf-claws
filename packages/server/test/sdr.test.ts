import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { buildDeployPackage, mdapiZipToSource, toVirtualDirectories } from '../src/salesforce/sdr.js';

/**
 * Conversion is now Salesforce's own source-deploy-retrieve rather than a hand-written converter.
 * Every assertion the hand-written one carried is ported here, followed by the cases it could not
 * handle — which is the reason for the change.
 */

const NS = 'http://soap.sforce.com/2006/04/metadata';

const field = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="${NS}">
    <fullName>Renewal_Date__c</fullName>
    <label>Renewal Date</label>
    <type>Date</type>
    <description>When the contract renews</description>
</CustomField>
`;
const secondField = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="${NS}"><fullName>Region__c</fullName><label>Region</label><type>Text</type><length>80</length></CustomField>
`;
const validationRule = `<?xml version="1.0" encoding="UTF-8"?>
<ValidationRule xmlns="${NS}"><fullName>Renewal_After_Start</fullName><active>true</active><errorConditionFormula>Renewal_Date__c &lt; CreatedDate</errorConditionFormula><errorMessage>Renewal must be later</errorMessage></ValidationRule>
`;
const flow = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="${NS}"><apiVersion>62.0</apiVersion><label>My Flow</label><status>Draft</status><processType>AutoLaunchedFlow</processType></Flow>
`;
const classMeta = `<?xml version="1.0" encoding="UTF-8"?>
<ApexClass xmlns="${NS}"><apiVersion>62.0</apiVersion><status>Active</status></ApexClass>
`;

async function entries(zipBuffer: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(zipBuffer);
  return Object.entries(zip.files)
    .filter(([, e]) => !e.dir)
    .map(([name]) => name)
    .sort();
}
async function read(zipBuffer: Buffer, name: string): Promise<string> {
  const zip = await JSZip.loadAsync(zipBuffer);
  const file = zip.file(name);
  if (!file) throw new Error(`${name} not in archive: ${Object.keys(zip.files).join(', ')}`);
  return file.async('string');
}

describe('virtual project tree', () => {
  it('lists every directory and links each one to its parent', () => {
    const dirs = toVirtualDirectories([{ path: 'objects/Account/fields/A__c.field-meta.xml', content: 'x' }], '/root');
    const paths = dirs.map((d) => d.dirPath);
    expect(paths).toEqual(expect.arrayContaining(['/root', '/root/objects', '/root/objects/Account', '/root/objects/Account/fields']));
    // Without the parent→child links SDR's walk stops at the first level.
    expect(dirs.find((d) => d.dirPath === '/root/objects')!.children.some((c) => (c as { name: string }).name === 'Account')).toBe(true);
    expect(dirs.find((d) => d.dirPath === '/root/objects/Account/fields')!.children[0]).toMatchObject({ name: 'A__c.field-meta.xml' });
  });
});

describe('source to deploy package', () => {
  it('recomposes a decomposed field into its object and builds package.xml', async () => {
    const { zipBuffer, components, packageXml } = await buildDeployPackage(
      [
        { path: 'objects/Account/fields/Renewal_Date__c.field-meta.xml', content: field },
        { path: 'flows/My_Flow.flow-meta.xml', content: flow },
      ],
      '62.0',
    );

    const objectFile = await read(zipBuffer, 'objects/Account.object');
    expect(objectFile).toContain('<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">');
    expect(objectFile).toContain('<fullName>Renewal_Date__c</fullName>');
    // The child element is <fields>, not a nested <CustomField> document.
    expect(objectFile).toContain('<fields>');
    expect(objectFile).not.toContain('<CustomField');

    expect(await entries(zipBuffer)).toEqual(expect.arrayContaining(['flows/My_Flow.flow', 'objects/Account.object', 'package.xml']));
    expect(packageXml).toContain('<members>Account.Renewal_Date__c</members>');
    expect(packageXml).toContain('<name>CustomField</name>');
    expect(packageXml).toContain('<name>Flow</name>');
    expect(packageXml).toContain('<version>62.0</version>');
    expect(components).toEqual(
      expect.arrayContaining([
        { type: 'CustomField', fullName: 'Account.Renewal_Date__c' },
        { type: 'Flow', fullName: 'My_Flow' },
      ]),
    );
  });

  it('merges several children of one object into a single object file', async () => {
    // The hand-written converter handled one child at a time; a field plus a validation rule on the
    // same object has to land in one <CustomObject>, not two competing files.
    const { zipBuffer } = await buildDeployPackage(
      [
        { path: 'objects/Account/fields/Renewal_Date__c.field-meta.xml', content: field },
        { path: 'objects/Account/fields/Region__c.field-meta.xml', content: secondField },
        { path: 'objects/Account/validationRules/Renewal_After_Start.validationRule-meta.xml', content: validationRule },
      ],
      '62.0',
    );
    const objectFiles = (await entries(zipBuffer)).filter((n) => n.startsWith('objects/'));
    expect(objectFiles).toEqual(['objects/Account.object']);

    const objectFile = await read(zipBuffer, 'objects/Account.object');
    expect(objectFile).toContain('Renewal_Date__c');
    expect(objectFile).toContain('Region__c');
    expect(objectFile).toContain('<validationRules>');
    expect(objectFile).toContain('Renewal_After_Start');
  });

  it('keeps Apex companion meta files beside their content file', async () => {
    const { zipBuffer } = await buildDeployPackage(
      [
        { path: 'classes/Foo.cls', content: 'public class Foo {}' },
        { path: 'classes/Foo.cls-meta.xml', content: classMeta },
      ],
      '62.0',
    );
    expect(await entries(zipBuffer)).toEqual(['classes/Foo.cls', 'classes/Foo.cls-meta.xml', 'package.xml']);
  });

  it('carries a whole LWC bundle across', async () => {
    const { zipBuffer, components } = await buildDeployPackage(
      [
        { path: 'lwc/greeter/greeter.js', content: 'export default class Greeter {}' },
        { path: 'lwc/greeter/greeter.html', content: '<template></template>' },
        { path: 'lwc/greeter/greeter.css', content: ':host { display: block }' },
        {
          path: 'lwc/greeter/greeter.js-meta.xml',
          content: `<?xml version="1.0" encoding="UTF-8"?><LightningComponentBundle xmlns="${NS}"><apiVersion>62.0</apiVersion><isExposed>false</isExposed></LightningComponentBundle>`,
        },
      ],
      '62.0',
    );
    expect(components).toEqual([{ type: 'LightningComponentBundle', fullName: 'greeter' }]);
    const names = await entries(zipBuffer);
    // Every member of the bundle travels, including the stylesheet a path heuristic would miss.
    expect(names).toEqual(
      expect.arrayContaining(['lwc/greeter/greeter.js', 'lwc/greeter/greeter.html', 'lwc/greeter/greeter.css', 'lwc/greeter/greeter.js-meta.xml']),
    );
  });

  it('puts deletions in destructiveChangesPost.xml and never in package.xml', async () => {
    const { zipBuffer } = await buildDeployPackage([{ path: 'flows/My_Flow.flow-meta.xml', content: flow }], '62.0', [
      { type: 'CustomField', fullName: 'Account.Obsolete__c' },
      { type: 'Flow', fullName: 'Old_Flow' },
    ]);

    const destructive = await read(zipBuffer, 'destructiveChangesPost.xml');
    expect(destructive).toContain('<members>Account.Obsolete__c</members>');
    expect(destructive).toContain('<members>Old_Flow</members>');

    // The distinction matters: a deletion listed in package.xml asks Salesforce to create it.
    const pkg = await read(zipBuffer, 'package.xml');
    expect(pkg).not.toContain('Obsolete__c');
    expect(pkg).not.toContain('Old_Flow');
    expect(pkg).toContain('<members>My_Flow</members>');
  });

  it('builds a deletion-only package with an empty manifest', async () => {
    const { zipBuffer, components } = await buildDeployPackage([], '62.0', [{ type: 'ApexClass', fullName: 'Dead' }]);
    expect(components).toEqual([]);
    expect(await read(zipBuffer, 'package.xml')).not.toContain('<types>');
    expect(await read(zipBuffer, 'destructiveChangesPost.xml')).toContain('<members>Dead</members>');
  });

  it('refuses an empty package rather than deploying nothing', async () => {
    await expect(buildDeployPackage([], '62.0', [])).rejects.toThrow(/Nothing to deploy/);
  });

  it('explains itself when no file maps to a metadata component', async () => {
    await expect(buildDeployPackage([{ path: 'notes/scratch.txt', content: 'hello' }], '62.0')).rejects.toThrow(/source-format paths/);
  });
});

describe('retrieve archive to source', () => {
  it('decomposes an object back into its child files', async () => {
    const { zipBuffer } = await buildDeployPackage([{ path: 'objects/Account/fields/Renewal_Date__c.field-meta.xml', content: field }], '62.0');
    const source = await mdapiZipToSource(zipBuffer);
    const paths = source.map((f) => f.path);

    expect(paths).toContain('objects/Account/fields/Renewal_Date__c.field-meta.xml');
    expect(paths).toContain('objects/Account/Account.object-meta.xml');
    const child = source.find((f) => f.path.endsWith('Renewal_Date__c.field-meta.xml'))!;
    expect(child.content).toContain('<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">');
    expect(child.content).toContain('<label>Renewal Date</label>');
  });

  it('round-trips a mixed package without losing a component', async () => {
    const original = [
      { path: 'objects/Account/fields/Renewal_Date__c.field-meta.xml', content: field },
      { path: 'objects/Account/fields/Region__c.field-meta.xml', content: secondField },
      { path: 'classes/Foo.cls', content: 'public class Foo {}' },
      { path: 'classes/Foo.cls-meta.xml', content: classMeta },
      { path: 'flows/My_Flow.flow-meta.xml', content: flow },
    ];
    const { zipBuffer } = await buildDeployPackage(original, '62.0');
    const source = await mdapiZipToSource(zipBuffer);
    const paths = source.map((f) => f.path);

    for (const f of original) expect(paths, `${f.path} survived the round trip`).toContain(f.path);
    // Paths come back relative to the source root, not under SDR's package directory.
    expect(paths.every((p) => !p.startsWith('main/default/'))).toBe(true);
  });

  it('carries a binary static resource through both directions byte-exact', async () => {
    // A small zip archive: not valid UTF-8, and every byte matters. The resource is typed as an
    // octet stream so SDR keeps it as one file rather than exploding it into a folder.
    const inner = new JSZip();
    inner.file('hello.txt', 'hello');
    const bytes = await inner.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toThrow();
    const meta = `<?xml version="1.0" encoding="UTF-8"?><StaticResource xmlns="${NS}"><cacheControl>Private</cacheControl><contentType>application/octet-stream</contentType></StaticResource>`;

    const { zipBuffer } = await buildDeployPackage(
      [
        { path: 'staticresources/Bundle.resource', content: bytes.toString('base64'), encoding: 'base64' },
        { path: 'staticresources/Bundle.resource-meta.xml', content: meta },
      ],
      '62.0',
    );
    const zip = await JSZip.loadAsync(zipBuffer);
    expect(Buffer.compare(await zip.file('staticresources/Bundle.resource')!.async('nodebuffer'), bytes)).toBe(0);

    const source = await mdapiZipToSource(zipBuffer);
    // In source format SDR names the content file after its MIME type (`Bundle.bin`), not `.resource`.
    const resource = source.find((f) => f.path.startsWith('staticresources/Bundle.') && !f.path.endsWith('-meta.xml'))!;
    expect(resource, source.map((f) => f.path).join(', ')).toBeDefined();
    expect(resource.encoding).toBe('base64');
    expect(Buffer.compare(Buffer.from(resource.content, 'base64'), bytes)).toBe(0);
    // Text next to it stays text, so stored rows and diffs are unchanged.
    expect(source.find((f) => f.path === 'staticresources/Bundle.resource-meta.xml')!.encoding).toBeUndefined();

    // And the source files go back to a deploy zip without the workspace ever decoding them.
    const again = await buildDeployPackage(source, '62.0');
    const againZip = await JSZip.loadAsync(again.zipBuffer);
    expect(Buffer.compare(await againZip.file('staticresources/Bundle.resource')!.async('nodebuffer'), bytes)).toBe(0);
  });

  it('returns nothing for an archive with no components', async () => {
    const zip = new JSZip();
    zip.file('package.xml', `<?xml version="1.0" encoding="UTF-8"?><Package xmlns="${NS}"><version>62.0</version></Package>`);
    expect(await mdapiZipToSource(await zip.generateAsync({ type: 'nodebuffer' }))).toEqual([]);
  });
});
