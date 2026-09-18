import type { Connection } from 'jsforce';
import type { WorkspaceFile } from '@sf-claws/shared';
import type { DeployOutcome, DeployOptions } from './service.js';
import { normalizeDeployResult, soqlLiteral } from './service.js';
import { newId } from '../lib/crypto.js';

export interface ToolingMember {
  type: 'ApexClass' | 'ApexTrigger';
  id: string;
  name: string;
  path: string;
  body: string;
}
export interface ToolingJob {
  id: string;
  containerId: string;
}

/** Existing unmanaged Apex bodies only. Companion metadata must be unchanged. No creation/deletion. */
export function toolingEligible(files: WorkspaceFile[]): boolean {
  return (
    files.some((f) => /\.(cls|trigger)$/.test(f.path)) &&
    files.every(
      (f) =>
        ['ApexClass', 'ApexTrigger'].includes(f.metadataType ?? '') &&
        f.action === 'modified' &&
        f.original !== null &&
        (/\.(cls|trigger)$/.test(f.path) || (/\.(cls|trigger)-meta\.xml$/.test(f.path) && f.content === f.original)),
    )
  );
}

export async function resolveToolingMembers(conn: Connection, files: WorkspaceFile[]): Promise<ToolingMember[] | null> {
  if (!toolingEligible(files)) return null;
  const members: ToolingMember[] = [];
  for (const file of files.filter((f) => /\.(cls|trigger)$/.test(f.path))) {
    if (!file.fullName || !/^[A-Za-z][A-Za-z0-9_]*$/.test(file.fullName)) return null;
    const result: any = await conn.tooling.query(
      `SELECT Id, Name, ApiVersion FROM ${file.metadataType} WHERE Name=${soqlLiteral(file.fullName)} AND NamespacePrefix=null`,
    );
    if (result.records?.length !== 1) return null;
    members.push({ type: file.metadataType as ToolingMember['type'], id: result.records[0].Id, name: file.fullName, path: file.path, body: file.content });
  }
  return members;
}

function saved(result: any): string {
  if (!result.success || !result.id) throw new Error(JSON.stringify(result.errors ?? result));
  return result.id;
}

/** The only writable sObjects here are temporary compiler records, never ApexClass/ApexTrigger. */
export async function submitToolingCompile(conn: Connection, members: ToolingMember[], onContainer: (id: string) => void): Promise<ToolingJob> {
  const containerId = saved(await conn.tooling.sobject('MetadataContainer').create({ Name: newId('sfclaws').slice(0, 40) } as any));
  onContainer(containerId);
  for (const member of members) {
    saved(
      await conn.tooling.sobject(`${member.type}Member`).create({ MetadataContainerId: containerId, ContentEntityId: member.id, Body: member.body } as any),
    );
  }
  const id = saved(await conn.tooling.sobject('ContainerAsyncRequest').create({ MetadataContainerId: containerId, IsCheckOnly: true } as any));
  return { id, containerId };
}

export async function pollToolingCompile(
  conn: Connection,
  job: ToolingJob,
  opts: Pick<DeployOptions, 'timeoutMs' | 'onProgress'> = {},
): Promise<DeployOutcome> {
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  for (;;) {
    const result: any = await conn.tooling.sobject('ContainerAsyncRequest').retrieve(job.id);
    opts.onProgress?.(`Tooling compile: ${result.State}`);
    if (!['Queued', 'Processing'].includes(result.State)) {
      if (!['Completed', 'Failed', 'Error', 'Invalidated', 'Aborted'].includes(result.State))
        throw new Error(`Unknown compiler state ${result.State}; reconcile job ${job.id}`);
      const details = typeof result.DeployDetails === 'string' ? JSON.parse(result.DeployDetails) : (result.DeployDetails ?? {});
      const outcome = normalizeDeployResult({
        id: job.id,
        status: result.State === 'Completed' ? 'Succeeded' : 'Failed',
        success: result.State === 'Completed',
        checkOnly: true,
        details,
        numberComponentsTotal: details.componentSuccesses?.length ?? 0,
        numberComponentErrors: Array.isArray(details.componentFailures) ? details.componentFailures.length : details.componentFailures ? 1 : 0,
        errorMessage: result.ErrorMsg || (result.State !== 'Completed' && !details.componentFailures ? `Compiler state ${result.State}` : null),
      });
      return outcome;
    }
    if (Date.now() >= deadline) throw new Error(`Tooling compile ${job.id} timed out; reconcile this job before submitting another.`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export async function reconcileToolingContainer(conn: Connection, containerId: string): Promise<ToolingJob | null> {
  const result: any = await conn.tooling.query(
    `SELECT Id FROM ContainerAsyncRequest WHERE MetadataContainerId=${soqlLiteral(containerId)} ORDER BY CreatedDate DESC LIMIT 1`,
  );
  return result.records?.[0]?.Id ? { id: result.records[0].Id, containerId } : null;
}
