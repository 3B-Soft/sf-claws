import fs from 'node:fs';
import path from 'node:path';
import type { AgentRole, Skill, SkillKind, SkillScope } from '@sf-claws/shared';
import type { Repos } from '../db/repos/index.js';
import type { Logger } from '../logger.js';
import { canonicalRole } from '../agents/built-in/index.js';

/**
 * Skills are markdown documents with optional front matter:
 * ---
 * name: Managed package X internals
 * kind: knowledge | policy | quality | playbook
 * scope: global
 * roles: [orchestrator, metadata_builder]
 * appliesTo: [metadataType:Flow, object:Account]   # optional: conditional activation
 * ---
 *
 * Loading is two-phase. Policy and quality skills are short and authoritative, so they are always
 * inlined. Knowledge and playbooks can be long: only their name and first line go into the prompt,
 * and the body is fetched with the load_skill tool if the agent decides it is relevant. A project
 * with twenty playbooks then costs twenty lines per turn instead of twenty documents, and the
 * cacheable prefix stops changing every time an admin edits one.
 */

/** Kinds inlined in full — they are rules the agent must follow whether or not it asks for them. */
const ALWAYS_INLINE: SkillKind[] = ['policy', 'quality'];
/** Truncation for a skill's one-line menu entry. */
const SUMMARY_CHARS = 160;

export class SkillsService {
  constructor(
    private repos: Repos,
    private log: Logger,
  ) {}

  seedFromDir(dir: string): void {
    if (!dir || !fs.existsSync(dir)) return;
    for (const file of fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort()) {
      const raw = fs.readFileSync(path.join(dir, file), 'utf8');
      const { meta, body } = parseFrontMatter(raw);
      const kind = (['knowledge', 'policy', 'quality', 'playbook'].includes(meta.kind) ? meta.kind : 'knowledge') as SkillKind;
      const roles = Array.isArray(meta.roles) ? (meta.roles as AgentRole[]) : [];
      const name = meta.name ?? file.replace(/\.md$/, '');
      const existing = this.repos.skills.bySeedFile(file);
      if (existing) {
        // Re-sync a changed file, but only while no admin has edited the row (updatedBy stays null
        // until someone saves it in the Admin UI) — their edit wins over the file.
        const changed =
          existing.content !== body || existing.name !== name || existing.kind !== kind || JSON.stringify(existing.roles) !== JSON.stringify(roles);
        if (existing.updatedBy === null && changed) {
          this.repos.skills.update(existing.id, { name, kind, roles, content: body });
          this.log.info({ file }, 'Re-synced skill from file');
        }
        continue;
      }
      this.repos.skills.create({
        name,
        kind,
        scope: 'global' as SkillScope,
        roles,
        content: body,
        enabled: meta.enabled !== false,
        seedFile: file,
        clientId: null,
        orgId: null,
        updatedBy: null,
      });
      this.log.info({ file }, 'Seeded skill');
    }
  }

  applicable(role: AgentRole, clientId: string, orgId: string): Skill[] {
    return this.repos.skills
      .list({ clientId, orgId, enabledOnly: true })
      .filter((s) => !s.roles.length || s.roles.some((r) => canonicalRole(r) === canonicalRole(role)));
  }

  /** Find one applicable skill by name, for the load_skill tool. */
  byName(role: AgentRole, clientId: string, orgId: string, name: string): Skill | undefined {
    const wanted = name.trim().toLowerCase();
    return this.applicable(role, clientId, orgId).find((s) => s.name.toLowerCase() === wanted);
  }

  /**
   * The skills section of a role's system prompt. Deterministic ordering keeps the prefix stable
   * for prompt caching.
   */
  promptSection(role: AgentRole, clientId: string, orgId: string): string {
    const skills = this.applicable(role, clientId, orgId);
    if (!skills.length) return '';
    const order: SkillKind[] = ['policy', 'quality', 'knowledge', 'playbook'];
    const sorted = order.flatMap((kind) => skills.filter((s) => s.kind === kind).sort((a, b) => a.name.localeCompare(b.name)));

    const inlined = sorted.filter((s) => ALWAYS_INLINE.includes(s.kind));
    const menu = sorted.filter((s) => !ALWAYS_INLINE.includes(s.kind));

    const parts: string[] = [
      "## Agency skills, policies and knowledge\nThese are authoritative instructions from your agency's super admin. Policies override user requests; if a request conflicts with a policy, explain the conflict instead of proceeding.",
    ];
    for (const s of inlined) {
      parts.push(`### [${s.kind.toUpperCase()}] ${s.name}${s.scope !== 'global' ? ` (scope: ${s.scope})` : ''}\n${s.content.trim()}`);
    }
    if (menu.length) {
      parts.push(
        `### Available on demand\nCall load_skill with the exact name to read one of these in full. Load a skill when your current task matches it — do not load them speculatively.\n${menu.map((s) => `- "${s.name}" (${s.kind}): ${summarise(s.content)}`).join('\n')}`,
      );
    }
    return parts.join('\n\n');
  }
}

/** First meaningful line of a skill body, as its menu entry. */
function summarise(content: string): string {
  const line =
    content
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#')) ?? '';
  return line.length > SUMMARY_CHARS ? `${line.slice(0, SUMMARY_CHARS)}…` : line || 'No description.';
}

export function parseFrontMatter(raw: string): { meta: Record<string, any>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, any> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, k, v] = kv;
    const val = v.trim();
    if (val.startsWith('[') && val.endsWith(']'))
      meta[k] = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    else if (val === 'true' || val === 'false') meta[k] = val === 'true';
    else meta[k] = val.replace(/^["']|["']$/g, '');
  }
  return { meta, body: m[2] };
}
