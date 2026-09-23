import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** Load a .env file into process.env without overriding existing values (no dependency). */
export function loadDotEnv(file = '.env'): void {
  const p = path.resolve(process.cwd(), file);
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

const Env = z.object({
  PORT: z.coerce.number().int().default(8787),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_URL: z.string().url().default('http://localhost:8787'),
  DATA_DIR: z.string().default('./data'),
  MASTER_KEY: z.string().min(32, 'MASTER_KEY must be at least 32 chars (base64 of 32 random bytes)'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 chars'),
  JWT_TTL_HOURS: z.coerce.number().positive().default(72),
  SF_CLIENT_ID: z.string().default(''),
  SF_CLIENT_SECRET: z.string().default(''),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  ADMIN_UI_DIST: z.string().default(''),
  SKILLS_SEED_DIR: z.string().default('../../skills'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  /**
   * Trust X-Forwarded-* headers from the immediate upstream. Off by default: with no proxy in
   * front, an honoured X-Forwarded-For lets any caller choose the IP written to the audit log
   * and used as the rate-limit key. Set to true only behind a proxy that overwrites the header.
   */
  TRUST_PROXY: z
    .string()
    .default('false')
    .transform((v) => ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())),
  BOOTSTRAP_ADMIN_EMAIL: z.string().default(''),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().default(''),
  // Optional development/deployment fallbacks. Credentials saved in the UI take precedence.
  ANTHROPIC_API_KEY: z.string().default(''),
  OPENAI_API_KEY: z.string().default(''),
  GEMINI_API_KEY: z.string().default(''),
  DEEPSEEK_API_KEY: z.string().default(''),
  DEEPINFRA_API_KEY: z.string().default(''),
  GITHUB_TOKEN: z.string().default(''),
  BRAVE_SEARCH_API_KEY: z.string().default(''),
  NODE_ENV: z.string().default('development'),
});

export type Config = z.infer<typeof Env> & {
  dataDir: string;
  dbPath: string;
  workspacesDir: string;
  corsOrigins: string[];
  version: string;
};

export function loadConfig(overrides: Partial<Record<keyof z.infer<typeof Env>, string>> = {}): Config {
  loadDotEnv();
  const parsed = Env.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${msg}\nCopy .env.example to .env and fill in the values.`);
  }
  const env = parsed.data;
  const dataDir = path.resolve(process.cwd(), env.DATA_DIR);
  return {
    ...env,
    dataDir,
    dbPath: path.join(dataDir, 'harness.sqlite'),
    workspacesDir: path.join(dataDir, 'workspaces'),
    corsOrigins: env.CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    version: readVersion(),
  };
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
