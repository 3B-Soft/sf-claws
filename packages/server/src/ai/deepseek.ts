import { OpenAiCompatibleProvider, type OpenAiDialect } from './openai.js';

/**
 * DeepSeek speaks the OpenAI Chat Completions protocol, so it rides the shared transport. Three
 * things differ from OpenAI proper:
 *
 * - it only understands `max_tokens`, not `max_completion_tokens`;
 * - `deepseek-reasoner` takes no `reasoning_effort` knob — it decides how long to think itself and
 *   streams that thinking back as `reasoning_content`, which the transport surfaces as thinking
 *   blocks. Those blocks are dropped on replay (DeepSeek rejects reasoning fed back in), so the
 *   effort a role binding asks for is advisory here rather than enforced;
 * - cache hits are reported as `prompt_cache_hit_tokens` rather than `prompt_tokens_details`.
 */
export const DEEPSEEK_DIALECT: OpenAiDialect = {
  provider: 'deepseek',
  label: 'DeepSeek',
  defaultBaseUrl: 'https://api.deepseek.com/v1',
  defaultTestModel: 'deepseek-chat',
};

export class DeepseekProvider extends OpenAiCompatibleProvider {
  constructor(apiKey: string, baseUrl?: string | null) {
    super(apiKey, baseUrl, DEEPSEEK_DIALECT);
  }
}
