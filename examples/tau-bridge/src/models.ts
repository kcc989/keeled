import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { defaultSettingsMiddleware, wrapLanguageModel, type LanguageModel } from 'ai';

/**
 * OpenRouter models for the bridge, pinned to the listed providers in order with no fallback
 * beyond them. Benchmark tool schemas use optional fields and open objects, which strict
 * structured output rejects, so strict mode is off.
 */
export function openRouterModels(modelId: string, apiKey: string, providers: readonly string[]) {
  const openrouter = createOpenAICompatible({
    name: 'openrouter',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey,
    supportsStructuredOutputs: true,
  });
  const routed = (extra: Record<string, unknown> = {}): LanguageModel =>
    wrapLanguageModel({
      model: openrouter(modelId),
      middleware: defaultSettingsMiddleware({
        settings: {
          providerOptions: {
            openrouter: {
              strictJsonSchema: false,
              provider: { order: [...providers], allow_fallbacks: false, require_parameters: true },
              ...extra,
            },
          },
        },
      }),
    });
  return {
    model: routed(),
    // Filling in read arguments and keeping the request ledger are extraction.
    argumentsModel: routed({ reasoning: { enabled: false } }),
    // State-changing calls combine policy, prior results, and several exact fields.
    writeArgumentsModel: routed({ reasoning: { effort: 'low' } }),
  };
}

export function providersFromEnvironment(): string[] {
  return (process.env['OPENROUTER_PROVIDERS'] ?? 'together,modal').split(',').map(provider => provider.trim());
}
