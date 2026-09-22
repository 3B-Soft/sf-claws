import type { AgentRole } from '@sf-claws/shared';

/** Definitions describe behavior; toolsForRole enforces capabilities independently of prompts. */
export interface BuiltInAgentDefinition {
  role: AgentRole;
  whenToUse: string;
  readOnly: boolean;
  identity: string;
  guidance: string;
}
