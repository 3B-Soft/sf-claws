import { OpenAiCompatibleProvider, type OpenAiDialect } from './openai.js';

/**
 * DeepInfra hosts open models behind the OpenAI Chat Completions protocol, so it needs an endpoint
 * and nothing else. Two things to know when adding models to the catalogue:
 *
 * - model ids are namespaced by the publisher (`deepseek-ai/DeepSeek-V3`, `meta-llama/...`), which
 *   the catalogue stores verbatim;
 * - reasoning behaviour belongs to the hosted model, not the host. Models that report their
 *   thinking in `reasoning_content` surface it as thinking blocks; the rest simply never send it.
 *   Nothing here asks a hosted model for an effort level, because most of them do not accept one.
 */
export const DEEPINFRA_DIALECT: OpenAiDialect = {
  provider: 'deepinfra',
  label: 'DeepInfra',
  defaultBaseUrl: 'https://api.deepinfra.com/v1/openai',
  defaultTestModel: 'deepseek-ai/DeepSeek-V3',
  maxTokensParam: 'max_tokens',
  reasoning: 'reasoning_content',
};

export class DeepinfraProvider extends OpenAiCompatibleProvider {
  constructor(apiKey: string, baseUrl?: string | null) {
    super(apiKey, baseUrl, DEEPINFRA_DIALECT);
  }
}
