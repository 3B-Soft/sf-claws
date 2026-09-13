import type { Config } from './config.js';
import type { Repos } from './db/repos/index.js';
import type { Db } from './db/db.js';
import type { Logger } from './logger.js';
import type { SecretBox } from './lib/crypto.js';
import type { AuthService } from './auth/service.js';
import type { SalesforceService } from './salesforce/service.js';
import type { GithubService } from './github/service.js';
import type { AiRegistry } from './ai/registry.js';
import type { SessionRuntime } from './agents/runtime.js';
import type { SkillsService } from './skills/service.js';
import type { PolicyService } from './agents/policy.js';
import type { KnowledgeService } from './knowledge/service.js';

export interface AppContext {
  config: Config;
  db: Db;
  repos: Repos;
  log: Logger;
  secrets: SecretBox;
  auth: AuthService;
  sf: SalesforceService;
  github: GithubService;
  ai: AiRegistry;
  skills: SkillsService;
  policy: PolicyService;
  knowledge: KnowledgeService;
  runtime: SessionRuntime;
}
