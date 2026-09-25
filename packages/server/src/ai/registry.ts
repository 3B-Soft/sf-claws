import type { AgentRole, AiModel, AiProvider, RoleModelBinding } from '@sf-claws/shared';
import type { Repos } from '../db/repos/index.js';
import type { SecretBox } from '../lib/crypto.js';
import type { Logger } from '../logger.js';
import type { LlmProvider, LlmUsage } from './types.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAiProvider } from './openai.js';
import { DeepseekProvider } from './deepseek.js';
import { DeepinfraProvider } from './deepinfra.js';
import { GeminiProvider } from './gemini.js';
import { HttpError } from '../lib/errors.js';

/** Default catalogue seeded on first boot (prices in USD per 1M tokens; OpenAI and DeepSeek values are placeholders admins should verify). */
export const DEFAULT_MODELS: Omit<AiModel, 'id' | 'createdAt'>[] = [
  {
    provider: 'anthropic',
    modelId: 'claude-opus-5',
    label: 'Claude Opus 5',
    enabled: true,
    inputCostPerM: 5,
    outputCostPerM: 25,
    cachedInputCostPerM: 0.5,
    maxOutputTokens: 32000,
    contextWindow: 1_000_000,
    supportsThinking: true,
  },
  {
    provider: 'anthropic',
    modelId: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    enabled: true,
    inputCostPerM: 2,
    outputCostPerM: 10,
    cachedInputCostPerM: 0.2,
    maxOutputTokens: 32000,
    contextWindow: 1_000_000,
    supportsThinking: true,
  },
  {
    provider: 'anthropic',
    modelId: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    enabled: true,
    inputCostPerM: 1,
    outputCostPerM: 5,
    cachedInputCostPerM: 0.1,
    maxOutputTokens: 16000,
    contextWindow: 200_000,
    supportsThinking: false,
  },
  {
    provider: 'openai',
    modelId: 'gpt-5',
    label: 'GPT-5',
    enabled: false,
    inputCostPerM: 1.25,
    outputCostPerM: 10,
    cachedInputCostPerM: 0.125,
    maxOutputTokens: 32000,
    contextWindow: 400_000,
    supportsThinking: true,
  },
  {
    provider: 'openai',
    modelId: 'gpt-5-mini',
    label: 'GPT-5 mini',
    enabled: false,
    inputCostPerM: 0.25,
    outputCostPerM: 2,
    cachedInputCostPerM: 0.025,
    maxOutputTokens: 32000,
    contextWindow: 400_000,
    supportsThinking: true,
  },
  {
    provider: 'deepseek',
    modelId: 'deepseek-chat',
    label: 'DeepSeek Chat',
    enabled: false,
    inputCostPerM: 0.28,
    outputCostPerM: 0.42,
    cachedInputCostPerM: 0.028,
    maxOutputTokens: 8000,
    contextWindow: 128_000,
    supportsThinking: false,
  },
  {
    provider: 'deepseek',
    modelId: 'deepseek-reasoner',
    label: 'DeepSeek Reasoner',
    enabled: false,
    inputCostPerM: 0.28,
    outputCostPerM: 0.42,
    cachedInputCostPerM: 0.028,
    maxOutputTokens: 64000,
    contextWindow: 128_000,
    supportsThinking: true,
  },
  {
    provider: 'deepseek',
    modelId: 'deepseek-v4-pro',
    label: 'deepseek-v4-pro',
    enabled: true,
    inputCostPerM: 1.32,
    outputCostPerM: 3.96,
    cachedInputCostPerM: 0.044,
    maxOutputTokens: 64_000,
    contextWindow: 1_000_000,
    supportsThinking: true,
  },
  {
    provider: 'deepseek',
    modelId: 'DeepSeek-V4.1-Flash',
    label: 'DeepSeek-V4.1-Flash',
    enabled: true,
    inputCostPerM: 0.3,
    outputCostPerM: 1.2,
    cachedInputCostPerM: 0.006,
    maxOutputTokens: 64_000,
    contextWindow: 1_000_000,
    supportsThinking: false,
  },
  {
    provider: 'gemini',
    modelId: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    enabled: false,
    inputCostPerM: 1.25,
    outputCostPerM: 10,
    cachedInputCostPerM: 0.31,
    maxOutputTokens: 65536,
    contextWindow: 1_048_576,
    supportsThinking: true,
  },
  {
    provider: 'gemini',
    modelId: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    enabled: false,
    inputCostPerM: 0.3,
    outputCostPerM: 2.5,
    cachedInputCostPerM: 0.075,
    maxOutputTokens: 65536,
    contextWindow: 1_048_576,
    supportsThinking: true,
  },
];

/** Default role bindings by provider model id (resolved to db ids on seed). */
export const DEFAULT_BINDINGS: { role: AgentRole; modelId: string; effort: RoleModelBinding['effort']; maxIterations: number }[] = [
  { role: 'general', modelId: 'deepseek-v4-pro', effort: 'xhigh', maxIterations: 40 },
  { role: 'explore', modelId: 'claude-haiku-4-5', effort: 'low', maxIterations: 30 },
  { role: 'plan', modelId: 'deepseek-v4-pro', effort: 'xhigh', maxIterations: 30 },
  { role: 'verify', modelId: 'deepseek-v4-pro', effort: 'xhigh', maxIterations: 20 },
  { role: 'orchestrator', modelId: 'deepseek-v4-pro', effort: 'xhigh', maxIterations: 60 },
  { role: 'analyst', modelId: 'deepseek-v4-pro', effort: 'xhigh', maxIterations: 40 },
  { role: 'metadata_builder', modelId: 'deepseek-v4-pro', effort: 'xhigh', maxIterations: 40 },
  { role: 'flow_builder', modelId: 'deepseek-v4-pro', effort: 'xhigh', maxIterations: 40 },
  { role: 'apex_builder', modelId: 'deepseek-v4-pro', effort: 'xhigh', maxIterations: 40 },
  { role: 'reviewer', modelId: 'deepseek-v4-pro', effort: 'xhigh', maxIterations: 20 },
  { role: 'doc_writer', modelId: 'deepseek-v4-pro', effort: 'xhigh', maxIterations: 10 },
  { role: 'researcher', modelId: 'deepseek-v4-pro', effort: 'xhigh', maxIterations: 30 },
  { role: 'summarizer', modelId: 'deepseek-v4-pro', effort: 'xhigh', maxIterations: 5 },
];

/** One place that knows which client class serves a provider id. */
function makeProvider(p: AiProvider, key: string, baseUrl: string | null | undefined): LlmProvider {
  switch (p) {
    case 'anthropic':
      return new AnthropicProvider(key, baseUrl);
    case 'deepseek':
      return new DeepseekProvider(key, baseUrl);
    case 'deepinfra':
      return new DeepinfraProvider(key, baseUrl);
    case 'gemini':
      return new GeminiProvider(key, baseUrl);
    default:
      return new OpenAiProvider(key, baseUrl);
  }
}

export class AiRegistry {
  /**
   * Provider clients, keyed by `userId|provider` — NOT by provider alone. A user may hold their own
   * API key, and keying on the provider would hand one user's client (and key) to everyone.
   */
  private providers = new Map<string, LlmProvider>();
  constructor(
    private repos: Repos,
    private secrets: SecretBox,
    private log: Logger,
    private environmentKeys: Partial<Record<AiProvider, string>> = {},
  ) {}

  /** Drop cached clients. Pass a user id to rotate only that user's key. */
  invalidate(userId?: string): void {
    if (!userId) {
      this.providers.clear();
      return;
    }
    for (const key of [...this.providers.keys()]) if (key.startsWith(`${userId}|`)) this.providers.delete(key);
  }

  seedDefaults(): void {
    let seeded = 0;
    for (const m of DEFAULT_MODELS) {
      if (!this.repos.models.byProviderModel(m.provider, m.modelId)) {
        this.repos.models.create(m);
        seeded++;
      }
    }
    if (seeded) this.log.info({ models: seeded }, 'Seeded default AI model catalogue');
    if (this.repos.bindings.list().length === 0) {
      const bindings: RoleModelBinding[] = [];
      for (const b of DEFAULT_BINDINGS) {
        const m = this.repos.models.list().find((candidate) => candidate.modelId === b.modelId) ?? this.repos.models.list()[0];
        if (m) bindings.push({ role: b.role, modelId: m.id, effort: b.effort, maxIterations: b.maxIterations });
      }
      if (bindings.length) this.repos.bindings.setAll(bindings);
    }
    const bindings = this.repos.bindings.list();
    const inherit: Partial<Record<AgentRole, AgentRole>> = { general: 'apex_builder', explore: 'analyst', plan: 'analyst', verify: 'reviewer' };
    let changed = false;
    for (const [role, old] of Object.entries(inherit)) {
      if (bindings.some((b) => b.role === role)) continue;
      const binding = bindings.find((b) => b.role === old) ?? bindings.find((b) => b.role === 'orchestrator');
      if (binding) {
        bindings.push({ ...binding, role: role as AgentRole });
        changed = true;
      }
    }
    if (changed) this.repos.bindings.setAll(bindings);
  }

  /**
   * A client for one provider, using this user's own key when they have one and the platform key
   * otherwise. Per-user keys let a deployment give each consultant their own provider account, so
   * spend and rate limits are attributed to them instead of competing on one shared key.
   */
  provider(p: AiProvider, userId?: string): LlmProvider {
    const cred = (userId ? this.repos.providers.get(p, userId) : undefined) ?? this.repos.providers.get(p);
    const environmentKey = this.environmentKeys[p]?.trim();
    if (!cred && !environmentKey)
      throw new HttpError(
        503,
        'PROVIDER_NOT_CONFIGURED',
        `No API key configured for ${p}. A super admin must add one in the admin console or server environment.`,
      );
    const cacheKey = `${cred?.userId ?? (cred ? 'global' : 'environment')}|${p}`;
    const cached = this.providers.get(cacheKey);
    if (cached) return cached;
    const key = cred ? this.secrets.decrypt(cred.apiKeyEnc) : environmentKey!;
    const inst = makeProvider(p, key, cred?.baseUrl);
    this.providers.set(cacheKey, inst);
    return inst;
  }

  async testProvider(p: AiProvider): Promise<{ ok: boolean; message: string }> {
    try {
      const model = this.repos.models.list().find((m) => m.provider === p && m.enabled);
      return await this.provider(p).test(model?.modelId);
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  /**
   * Resolve the model, provider client, effort and iteration cap for a role. Falls back to the
   * orchestrator binding, then any enabled model with a usable key. `userId` selects that user's
   * own provider key when they have one.
   */
  resolve(
    role: AgentRole,
    userId?: string,
  ): {
    model: AiModel;
    provider: LlmProvider;
    effort: RoleModelBinding['effort'];
    maxIterations: number;
    fallback: { model: AiModel; provider: LlmProvider } | null;
  } {
    const binding = this.repos.bindings.get(role) ?? this.repos.bindings.get('orchestrator');
    let model = binding ? this.repos.models.byId(binding.modelId) : undefined;
    if (!model?.enabled) {
      model = this.repos.models.list().find((m) => m.enabled && this.hasKey(m.provider, userId));
      if (!model) throw new HttpError(503, 'NO_MODEL', 'No enabled AI model with a configured provider. Ask a super admin to configure models.');
    }
    return {
      model,
      provider: this.provider(model.provider, userId),
      effort: binding?.effort ?? 'high',
      maxIterations: binding?.maxIterations ?? 40,
      fallback: this.resolveFallback(model, userId),
    };
  }

  /**
   * A second model to try when the primary is overloaded or rate limited: prefer another enabled
   * model from the same provider (same key, same shapes), otherwise any other enabled model.
   */
  private resolveFallback(primary: AiModel, userId?: string): { model: AiModel; provider: LlmProvider } | null {
    const candidates = this.repos.models.list().filter((m) => m.enabled && m.id !== primary.id && this.hasKey(m.provider, userId));
    const model = candidates.find((m) => m.provider === primary.provider) ?? candidates[0];
    if (!model) return null;
    try {
      return { model, provider: this.provider(model.provider, userId) };
    } catch {
      return null;
    }
  }

  hasKey(p: AiProvider, userId?: string): boolean {
    return !!((userId && this.repos.providers.get(p, userId)) || this.repos.providers.get(p) || this.environmentKeys[p]?.trim());
  }

  cost(model: AiModel, u: LlmUsage): number {
    const cachedRate = model.cachedInputCostPerM ?? model.inputCostPerM * 0.1;
    return (u.inputTokens * model.inputCostPerM + u.cachedInputTokens * cachedRate + u.outputTokens * model.outputCostPerM) / 1_000_000;
  }
}
