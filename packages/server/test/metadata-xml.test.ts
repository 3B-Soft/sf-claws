import { describe, it, expect } from 'vitest';
import { buildDestructiveChangesXml, buildPackageXml, escapeXml, validateXml, xmlToJson } from '../src/salesforce/metadata-xml.js';
import { inferComponentFromPath, sourcePathFor } from '@sf-claws/shared';

const NS = 'http://soap.sforce.com/2006/04/metadata';
const field = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="${NS}">
    <fullName>Renewal_Date__c</fullName>
    <label>Renewal Date</label>
    <type>Date</type>
</CustomField>
`;

describe('source path registry', () => {
  it('infers components from source paths', () => {
    expect(inferComponentFromPath('objects/Account/fields/Renewal_Date__c.field-meta.xml')).toEqual({
      metadataType: 'CustomField',
      fullName: 'Account.Renewal_Date__c',
    });
    expect(inferComponentFromPath('objects/Account/Account.object-meta.xml')).toEqual({ metadataType: 'CustomObject', fullName: 'Account' });
    expect(inferComponentFromPath('flows/My_Flow.flow-meta.xml')).toEqual({ metadataType: 'Flow', fullName: 'My_Flow' });
    expect(inferComponentFromPath('classes/Foo.cls')).toEqual({ metadataType: 'ApexClass', fullName: 'Foo' });
    expect(inferComponentFromPath('classes/Foo.cls-meta.xml')).toEqual({ metadataType: 'ApexClass', fullName: 'Foo' });
    expect(inferComponentFromPath('lwc/myCmp/myCmp.js')).toEqual({ metadataType: 'LightningComponentBundle', fullName: 'myCmp' });
    expect(inferComponentFromPath('layouts/Account-Account Layout.layout-meta.xml')).toEqual({ metadataType: 'Layout', fullName: 'Account-Account Layout' });
    expect(sourcePathFor('CustomField', 'Account.Renewal_Date__c')).toBe('objects/Account/fields/Renewal_Date__c.field-meta.xml');
  });
});

describe('manifests', () => {
  it('groups members under their type and stamps the api version', () => {
    const xml = buildPackageXml(
      [
        { name: 'CustomField', members: ['Account.Renewal_Date__c', 'Account.Region__c'] },
        { name: 'Flow', members: ['My_Flow'] },
      ],
      '62.0',
    );
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain(`<Package xmlns="${NS}">`);
    expect(xml).toContain('<members>Account.Renewal_Date__c</members>');
    expect(xml).toContain('<members>Account.Region__c</members>');
    expect(xml).toContain('<name>CustomField</name>');
    expect(xml).toContain('<version>62.0</version>');
  });

  it('escapes member names so a stray & cannot break the manifest', () => {
    expect(escapeXml('R&D <"x">')).toBe('R&amp;D &lt;&quot;x&quot;&gt;');
    expect(buildPackageXml([{ name: 'Layout', members: ['Account-R&D Layout'] }], '62.0')).toContain('<members>Account-R&amp;D Layout</members>');
  });

  it('collapses a flat deletion list into one <types> block per type', () => {
    const xml = buildDestructiveChangesXml(
      [
        { type: 'CustomField', fullName: 'Account.Obsolete__c' },
        { type: 'CustomField', fullName: 'Account.Legacy__c' },
        { type: 'ApexClass', fullName: 'Dead' },
      ],
      '62.0',
    );
    expect(xml.match(/<types>/g)).toHaveLength(2);
    expect(xml).toContain('<members>Account.Obsolete__c</members>');
    expect(xml).toContain('<members>Account.Legacy__c</members>');
    expect(xml).toContain('<name>ApexClass</name>');
  });
});

describe('validateXml', () => {
  it('accepts a well-formed document and reports the position of a broken one', () => {
    expect(validateXml(field)).toBeNull();
    expect(validateXml('<a><b></a>')).toMatch(/line \d+/);
    expect(validateXml('   ')).toBe('Empty XML document');
  });
});

describe('xmlToJson', () => {
  it('drops namespaces and keeps repeated children as arrays even when there is only one', () => {
    const obj = xmlToJson(
      `<?xml version="1.0"?><CustomObject xmlns="${NS}"><label>Account</label><fields><fullName>A__c</fullName></fields></CustomObject>`,
    ) as any;
    expect(obj.CustomObject.label).toBe('Account');
    // A renderer iterating fields must not have to special-case the one-field object.
    expect(Array.isArray(obj.CustomObject.fields)).toBe(true);
    expect(obj.CustomObject.fields[0].fullName).toBe('A__c');
    expect(JSON.stringify(obj)).not.toContain('xmlns');
  });
});
