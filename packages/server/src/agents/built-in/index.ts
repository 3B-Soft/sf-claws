import type { AgentRole } from '@sf-claws/shared';
import { generalAgent } from './general.js';
import { exploreAgent } from './explore.js';
import { planAgent } from './plan.js';
import { verifyAgent } from './verify.js';
import { orchestratorAgent } from './orchestrator.js';
import { doc_writerAgent } from './doc_writer.js';
import { researcherAgent } from './researcher.js';
import { summarizerAgent } from './summarizer.js';

export const BUILT_IN_AGENTS = [
  generalAgent,
  exploreAgent,
  planAgent,
  verifyAgent,
  orchestratorAgent,
  doc_writerAgent,
  researcherAgent,
  summarizerAgent,
] as const;

/** Old persisted roles and custom specialists remain readable during upgrades. */
export const ROLE_ALIASES: Partial<Record<AgentRole, AgentRole>> = {
  analyst: 'explore',
  metadata_builder: 'general',
  flow_builder: 'general',
  apex_builder: 'general',
  reviewer: 'verify',
};
export function canonicalRole(role: AgentRole): AgentRole {
  return ROLE_ALIASES[role] ?? role;
}
export function definitionFor(role: AgentRole) {
  return BUILT_IN_AGENTS.find((a) => a.role === canonicalRole(role));
}
export function guidanceFor(role: AgentRole): string {
  return definitionFor(role)?.guidance ?? '';
}
export const DELEGATABLE_ROLES: AgentRole[] = ['general', 'explore', 'plan', 'verify', 'doc_writer'];
export const READ_ONLY_ROLES = new Set<AgentRole>(['explore', 'plan', 'verify', 'analyst', 'reviewer', 'researcher']);
