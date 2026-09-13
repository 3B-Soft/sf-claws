import { z } from 'zod';

/**
 * Salesforce metadata helpers shared by server (deploy) and UI (visual rendering).
 */

/** Metadata types the visual builders understand first-class. Others fall back to XML/pro mode. */
export const VisualMetadataTypes = [
  'CustomObject',
  'CustomField',
  'Layout',
  'FlexiPage',
  'Flow',
  'ValidationRule',
  'RecordType',
  'PermissionSet',
  'CustomTab',
  'ListView',
  'QuickAction',
  'ApexClass',
  'ApexTrigger',
  'LightningComponentBundle',
  'CustomLabel',
  'CustomMetadata',
] as const;
export type VisualMetadataType = (typeof VisualMetadataTypes)[number];

/** Directory + suffix mapping for source format (subset of SDR registry, extended at runtime). */
export const SourceFormatRegistry: Record<string, { dir: string; suffix: string; folderPerComponent?: boolean; childOf?: string }> = {
  ApexClass: { dir: 'classes', suffix: 'cls' },
  ApexTrigger: { dir: 'triggers', suffix: 'trigger' },
  ApexPage: { dir: 'pages', suffix: 'page' },
  ApexComponent: { dir: 'components', suffix: 'component' },
  CustomObject: { dir: 'objects', suffix: 'object', folderPerComponent: true },
  CustomField: { dir: 'objects', suffix: 'field', childOf: 'CustomObject' },
  ValidationRule: { dir: 'objects', suffix: 'validationRule', childOf: 'CustomObject' },
  RecordType: { dir: 'objects', suffix: 'recordType', childOf: 'CustomObject' },
  ListView: { dir: 'objects', suffix: 'listView', childOf: 'CustomObject' },
  CompactLayout: { dir: 'objects', suffix: 'compactLayout', childOf: 'CustomObject' },
  WebLink: { dir: 'objects', suffix: 'webLink', childOf: 'CustomObject' },
  FieldSet: { dir: 'objects', suffix: 'fieldSet', childOf: 'CustomObject' },
  BusinessProcess: { dir: 'objects', suffix: 'businessProcess', childOf: 'CustomObject' },
  Layout: { dir: 'layouts', suffix: 'layout' },
  FlexiPage: { dir: 'flexipages', suffix: 'flexipage' },
  Flow: { dir: 'flows', suffix: 'flow' },
  FlowDefinition: { dir: 'flowDefinitions', suffix: 'flowDefinition' },
  PermissionSet: { dir: 'permissionsets', suffix: 'permissionset' },
  PermissionSetGroup: { dir: 'permissionsetgroups', suffix: 'permissionsetgroup' },
  Profile: { dir: 'profiles', suffix: 'profile' },
  CustomTab: { dir: 'tabs', suffix: 'tab' },
  CustomApplication: { dir: 'applications', suffix: 'app' },
  QuickAction: { dir: 'quickActions', suffix: 'quickAction' },
  CustomLabels: { dir: 'labels', suffix: 'labels' },
  CustomMetadata: { dir: 'customMetadata', suffix: 'md' },
  CustomPermission: { dir: 'customPermissions', suffix: 'customPermission' },
  GlobalValueSet: { dir: 'globalValueSets', suffix: 'globalValueSet' },
  StandardValueSet: { dir: 'standardValueSets', suffix: 'standardValueSet' },
  StaticResource: { dir: 'staticresources', suffix: 'resource' },
  EmailTemplate: { dir: 'email', suffix: 'email' },
  Report: { dir: 'reports', suffix: 'report' },
  Dashboard: { dir: 'dashboards', suffix: 'dashboard' },
  Group: { dir: 'groups', suffix: 'group' },
  Queue: { dir: 'queues', suffix: 'queue' },
  Role: { dir: 'roles', suffix: 'role' },
  Workflow: { dir: 'workflows', suffix: 'workflow' },
  AssignmentRules: { dir: 'assignmentRules', suffix: 'assignmentRules' },
  SharingRules: { dir: 'sharingRules', suffix: 'sharingRules' },
  RemoteSiteSetting: { dir: 'remoteSiteSettings', suffix: 'remoteSite' },
  NamedCredential: { dir: 'namedCredentials', suffix: 'namedCredential' },
  PlatformEventChannel: { dir: 'platformEventChannels', suffix: 'platformEventChannel' },
  LightningComponentBundle: { dir: 'lwc', suffix: '', folderPerComponent: true },
  AuraDefinitionBundle: { dir: 'aura', suffix: '', folderPerComponent: true },
  LightningMessageChannel: { dir: 'messageChannels', suffix: 'messageChannel' },
  DuplicateRule: { dir: 'duplicateRules', suffix: 'duplicateRule' },
  MatchingRules: { dir: 'matchingRules', suffix: 'matchingRule' },
  PathAssistant: { dir: 'pathAssistants', suffix: 'pathAssistant' },
  Settings: { dir: 'settings', suffix: 'settings' },
};

/** A file staged in a session workspace, in SFDX source format. */
export const WorkspaceFile = z.object({
  /** Path relative to the source root, e.g. objects/Account/fields/Foo__c.field-meta.xml */
  path: z.string(),
  content: z.string(),
  metadataType: z.string().nullable(),
  fullName: z.string().nullable(),
  /** Content in the org before this session changed it, when known. Enables visual diffs. */
  original: z.string().nullable().optional(),
  action: z.enum(['created', 'modified', 'deleted']),
});
export type WorkspaceFile = z.infer<typeof WorkspaceFile>;

export const DeployFailure = z.object({
  componentType: z.string().nullable(),
  fullName: z.string().nullable(),
  fileName: z.string().nullable(),
  problem: z.string(),
  problemType: z.string().nullable(),
  lineNumber: z.number().nullable(),
  columnNumber: z.number().nullable(),
});
export type DeployFailure = z.infer<typeof DeployFailure>;

export const DeployRun = z.object({
  id: z.string(),
  sessionId: z.string(),
  orgId: z.string(),
  checkOnly: z.boolean(),
  status: z.enum(['pending', 'in_progress', 'succeeded', 'failed', 'cancelled']),
  sfDeployId: z.string().nullable(),
  attempt: z.number().int(),
  componentsTotal: z.number().int(),
  componentsFailed: z.number().int(),
  testsTotal: z.number().int(),
  testsFailed: z.number().int(),
  codeCoverage: z.number().nullable(),
  failures: z.array(DeployFailure),
  testLevel: z.enum(['NoTestRun', 'RunSpecifiedTests', 'RunLocalTests', 'RunAllTestsInOrg']),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type DeployRun = z.infer<typeof DeployRun>;

/** Resolve a source-format path for a metadata component. */
export function sourcePathFor(metadataType: string, fullName: string, fileName?: string): string {
  const reg = SourceFormatRegistry[metadataType];
  if (!reg) {
    return `${metadataType.toLowerCase()}/${fullName}.${metadataType.toLowerCase()}-meta.xml`;
  }
  if (reg.childOf === 'CustomObject') {
    const [obj, child] = fullName.split('.');
    const childDir = reg.dir === 'objects' ? childDirFor(metadataType) : reg.dir;
    return `objects/${obj}/${childDir}/${child}.${reg.suffix}-meta.xml`;
  }
  if (metadataType === 'CustomObject') return `objects/${fullName}/${fullName}.object-meta.xml`;
  if (metadataType === 'LightningComponentBundle' || metadataType === 'AuraDefinitionBundle') {
    return `${reg.dir}/${fullName}/${fileName ?? fullName + '.js'}`;
  }
  if (metadataType === 'ApexClass' || metadataType === 'ApexTrigger' || metadataType === 'ApexPage' || metadataType === 'ApexComponent') {
    return fileName?.endsWith('-meta.xml') ? `${reg.dir}/${fullName}.${reg.suffix}-meta.xml` : `${reg.dir}/${fullName}.${reg.suffix}`;
  }
  if (metadataType === 'StaticResource') {
    return fileName ? `${reg.dir}/${fileName}` : `${reg.dir}/${fullName}.resource-meta.xml`;
  }
  return `${reg.dir}/${fullName}.${reg.suffix}-meta.xml`;
}

export function childDirFor(metadataType: string): string {
  switch (metadataType) {
    case 'CustomField':
      return 'fields';
    case 'ValidationRule':
      return 'validationRules';
    case 'RecordType':
      return 'recordTypes';
    case 'ListView':
      return 'listViews';
    case 'CompactLayout':
      return 'compactLayouts';
    case 'WebLink':
      return 'webLinks';
    case 'FieldSet':
      return 'fieldSets';
    case 'BusinessProcess':
      return 'businessProcesses';
    default:
      return metadataType.charAt(0).toLowerCase() + metadataType.slice(1) + 's';
  }
}

/** Reverse of sourcePathFor: infer { metadataType, fullName } from a source path. */
export function inferComponentFromPath(path: string): { metadataType: string; fullName: string } | null {
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const dir = parts[0];
  if (dir === 'objects') {
    const obj = parts[1];
    if (parts.length === 3) return { metadataType: 'CustomObject', fullName: obj };
    if (parts.length === 4) {
      const childDir = parts[2];
      const file = parts[3];
      const name = file.replace(/\.[^.]+-meta\.xml$/, '');
      const type = Object.entries(SourceFormatRegistry).find(([t, r]) => r.childOf === 'CustomObject' && childDirFor(t) === childDir)?.[0];
      if (type) return { metadataType: type, fullName: `${obj}.${name}` };
    }
    return null;
  }
  if (dir === 'lwc' || dir === 'aura') {
    return { metadataType: dir === 'lwc' ? 'LightningComponentBundle' : 'AuraDefinitionBundle', fullName: parts[1] };
  }
  const entry = Object.entries(SourceFormatRegistry).find(([, r]) => r.dir === dir && !r.childOf);
  if (!entry) return null;
  const file = parts[parts.length - 1];
  const fullName = file.replace(/-meta\.xml$/, '').replace(/\.[^.]+$/, '');
  return { metadataType: entry[0], fullName };
}
