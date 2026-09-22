import { OpenAiCompatibleProvider, type OpenAiDialect } from './openai.js';

/** Google Gemini's OpenAI-compatible Chat Completions endpoint. */
export const GEMINI_DIALECT: OpenAiDialect = {
  provider: 'gemini',
  label: 'Gemini',
  defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  defaultTestModel: 'gemini-2.5-flash',
};

export class GeminiProvider extends OpenAiCompatibleProvider {
  constructor(apiKey: string, baseUrl?: string | null) {
    super(apiKey, baseUrl, GEMINI_DIALECT);
  }
}
