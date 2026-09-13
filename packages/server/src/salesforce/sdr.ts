/**
 * SFDX source format ↔ Metadata API conversion, via Salesforce's own `source-deploy-retrieve`.
 *
 * SDR is the engine the `sf` CLI uses. Replacing a hand-written converter with it matters because
 * the interesting cases are not the ones you think of when writing your own: a CustomField has to
 * be recomposed into its parent `.object` for deployment and decomposed again on retrieve; bundles
 * (LWC, Aura, ExperienceBundle) have their own rules; translations, Territory2, decomposed
 * permission sets and workflow children each behave differently. SDR already knows all of that and
 * is updated with every Salesforce release.
 *
 * The one thing SDR assumes and we do not have is a filesystem. Our workspace is rows in SQLite —
 * deliberately, since agents must never touch the host filesystem on a multi-tenant server. SDR
 * supports this through `VirtualTreeContainer`, with one gap: it stores the bytes but leaves
 * `stream()` unimplemented, and the converter streams file contents into the zip. `StreamableTree`
 * below closes that gap in two lines.
 */
import { Readable } from 'node:stream';
import path from 'node:path';
import JSZip from 'jszip';
import { ComponentSet, MetadataConverter, VirtualTreeContainer, ZipTreeContainer } from '@salesforce/source-deploy-retrieve';
import { buildDestructiveChangesXml } from './metadata-xml.js';

export interface SourceFile {
  path: string;
  content: string;
  /**
   * How `content` encodes the file's bytes. Text metadata is `utf8` (the default, so existing
   * callers and stored rows are unchanged). Binary members — a StaticResource image, a Document,
   * a ContentAsset — are `base64`: decoding them as UTF-8 replaces every invalid sequence with
   * U+FFFD, and re-encoding hands Salesforce a corrupted file.
   */
  encoding?: SourceEncoding;
}
export type SourceEncoding = 'utf8' | 'base64';

/** The bytes a source file carries, whichever way it is encoded. */
export function sourceFileBytes(file: SourceFile): Buffer {
  return Buffer.from(file.content, file.encoding ?? 'utf8');
}

/**
 * Wrap raw bytes as a source file: UTF-8 text stays text, anything that does not decode cleanly
 * is carried as base64. The strict decoder is the test — a heuristic on the file suffix would call
 * a UTF-16 Document "text" and a JSON static resource "binary".
 */
export function sourceFileFromBytes(path: string, bytes: Buffer): SourceFile {
  try {
    return { path, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { path, content: bytes.toString('base64'), encoding: 'base64' };
  }
}

/**
 * Where the virtual project lives. Nothing is written here — the path exists only so SDR can
 * resolve package directories the way it would in a real SFDX project.
 */
const VIRTUAL_ROOT = '/sf-claws/force-app/main/default';

/** VirtualTreeContainer keeps the bytes in memory but does not implement stream(). */
class StreamableTree extends VirtualTreeContainer {
  override stream(fsPath: string): Readable {
    return Readable.from(this.readFileSync(fsPath));
  }
}

interface VirtualDirectory {
  dirPath: string;
  children: ({ name: string; data?: Buffer } | string)[];
}

/** Build the directory listing VirtualTreeContainer expects from a flat list of files. */
export function toVirtualDirectories(files: SourceFile[], root = VIRTUAL_ROOT): VirtualDirectory[] {
  const dirs = new Map<string, { name: string; data?: Buffer }[]>();
  const ensureDir = (dir: string): { name: string; data?: Buffer }[] => {
    let entry = dirs.get(dir);
    if (!entry) {
      entry = [];
      dirs.set(dir, entry);
      const parent = path.dirname(dir);
      if (parent !== dir) ensureDir(parent);
    }
    return entry;
  };

  ensureDir(root);
  for (const file of files) {
    const full = path.posix.join(root, file.path);
    ensureDir(path.dirname(full)).push({ name: path.basename(full), data: sourceFileBytes(file) });
  }
  // Every directory must also appear as a child of its parent, or the walk stops early.
  for (const dir of [...dirs.keys()]) {
    const parent = path.dirname(dir);
    if (parent === dir || !dirs.has(parent)) continue;
    const name = path.basename(dir);
    if (!dirs.get(parent)!.some((c) => c.name === name)) dirs.get(parent)!.push({ name });
  }
  return [...dirs.entries()].map(([dirPath, children]) => ({ dirPath, children }));
}

export interface DeployPackage {
  zipBuffer: Buffer;
  /** Components SDR resolved from the source, for the confirmation card and the audit trail. */
  components: { type: string; fullName: string }[];
  packageXml: string;
}

/**
 * Build the Metadata API deploy zip for a set of source-format files, plus optional deletions.
 *
 * Deletions are layered in as our own `destructiveChangesPost.xml` rather than through SDR's
 * destructive-changes API: asked to convert a component set that carries deletions, SDR folds those
 * members into `package.xml`, which would tell Salesforce to *create* them. The destructive
 * manifest itself has no edge cases worth delegating — it is a flat list of type and fullName.
 */
export async function buildDeployPackage(files: SourceFile[], apiVersion: string, deleted: { type: string; fullName: string }[] = []): Promise<DeployPackage> {
  if (!files.length && !deleted.length) throw new Error('Nothing to deploy: no files and no deletions.');

  let zipBuffer: Buffer;
  let components: { type: string; fullName: string }[] = [];
  let packageXml: string;

  if (files.length) {
    const componentSet = ComponentSet.fromSource({ fsPaths: [VIRTUAL_ROOT], tree: new StreamableTree(toVirtualDirectories(files)) });
    componentSet.apiVersion = apiVersion;
    components = componentSet
      .getSourceComponents()
      .toArray()
      .map((c) => ({ type: c.type.name, fullName: c.fullName }));
    if (!components.length) {
      throw new Error(
        'None of the staged files map to a Salesforce metadata component. Check the paths are SFDX source-format paths relative to the source root.',
      );
    }
    packageXml = await componentSet.getPackageXml();
    const converted = await new MetadataConverter().convert(componentSet, 'metadata', { type: 'zip' });
    if (!converted.zipBuffer) throw new Error('Metadata conversion produced no archive.');
    zipBuffer = converted.zipBuffer;
  } else {
    // Deletions only: an empty package plus the destructive manifest.
    packageXml = emptyPackageXml(apiVersion);
    const zip = new JSZip();
    zip.file('package.xml', packageXml);
    zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  }

  if (deleted.length) {
    const zip = await JSZip.loadAsync(zipBuffer);
    zip.file('destructiveChangesPost.xml', buildDestructiveChangesXml(deleted, apiVersion));
    zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  }

  return { zipBuffer, components, packageXml };
}

/**
 * Convert a Metadata API retrieve archive into source-format files, keyed by path relative to the
 * source root — the shape the workspace stores and the panel diffs.
 */
export async function mdapiZipToSource(zipBuffer: Buffer): Promise<SourceFile[]> {
  const componentSet = ComponentSet.fromSource({ fsPaths: ['.'], tree: await ZipTreeContainer.create(zipBuffer) });
  if (!componentSet.getSourceComponents().toArray().length) return [];

  const converted = await new MetadataConverter().convert(componentSet, 'source', { type: 'zip', genUniqueDir: false });
  if (!converted.zipBuffer) return [];

  const out: SourceFile[] = [];
  const zip = await JSZip.loadAsync(converted.zipBuffer);
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    out.push(sourceFileFromBytes(stripPackageDir(name), await entry.async('nodebuffer')));
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * SDR writes source output under its package-directory convention (`main/default/...`). The
 * workspace stores paths relative to the source root, so trim that prefix back off.
 */
function stripPackageDir(name: string): string {
  return name.replace(/^\/+/, '').replace(/^main\/default\//, '');
}

function emptyPackageXml(apiVersion: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n    <version>${apiVersion}</version>\n</Package>\n`;
}
