import path from 'node:path';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { openDb } from './db/db.js';
import { createRepos } from './db/repos/index.js';
import { SecretBox } from './lib/crypto.js';
import { AuthService } from './auth/service.js';
import { SalesforceService } from './salesforce/service.js';
import { GithubService } from './github/service.js';
import { AiRegistry } from './ai/registry.js';
import { SkillsService } from './skills/service.js';
import { PolicyService } from './agents/policy.js';
import { KnowledgeService } from './knowledge/service.js';
import { SessionRuntime } from './agents/runtime.js';
import { buildApp } from './http/app.js';
import type { AppContext } from './app-context.js';

export async function createContext(overrides: Parameters<typeof loadConfig>[0] = {}): Promise<AppContext> {
  const config = loadConfig(overrides);
  const log = createLogger(config.LOG_LEVEL, config.NODE_ENV !== 'production');
  const db = openDb(config.dbPath);
  const repos = createRepos(db);
  const secrets = new SecretBox(config.MASTER_KEY, repos.tenantKeys);
  const auth = new AuthService(repos, config);
  const sf = new SalesforceService(repos, config, secrets, log);
  const github = new GithubService(repos, secrets, log, config.GITHUB_TOKEN);
  const ai = new AiRegistry(repos, secrets, log, {
    anthropic: config.ANTHROPIC_API_KEY,
    openai: config.OPENAI_API_KEY,
    gemini: config.GEMINI_API_KEY,
    deepseek: config.DEEPSEEK_API_KEY,
    deepinfra: config.DEEPINFRA_API_KEY,
  });
  const skills = new SkillsService(repos, log);
  const policy = new PolicyService(repos);
  const knowledge = new KnowledgeService(repos, secrets, log);
  const base = { config, db, repos, log, secrets, auth, sf, github, ai, skills, policy, knowledge };
  const runtime = new SessionRuntime(base);
  const ctx: AppContext = { ...base, runtime };
  runtime.bind(ctx);
  return ctx;
}

async function main() {
  const ctx = await createContext();
  const { config, log } = ctx;
  await ctx.auth.bootstrapAdminIfConfigured();
  ctx.ai.seedDefaults();
  ctx.skills.seedFromDir(path.resolve(process.cwd(), config.SKILLS_SEED_DIR));
  ctx.runtime.recoverOnBoot();
  ctx.runtime.startIdleSweep();
  ctx.repos.tokens.purgeExpired();

  const app = await buildApp(ctx);
  await app.listen({ port: config.PORT, host: config.HOST });
  log.info({ url: config.PUBLIC_URL, port: config.PORT, setupRequired: ctx.repos.users.count() === 0 }, 'SF Claws server started');

  const shutdown = async (sig: string) => {
    log.info({ sig }, 'shutting down');
    ctx.runtime.stopIdleSweep();
    await app.close();
    ctx.db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain)
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
