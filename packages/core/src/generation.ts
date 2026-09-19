import { Output, generateText } from 'ai';
import type { LanguageModel } from 'ai';
import { HarnessError } from './errors.ts';
import type {
  GeneratedObjectResult,
  GeneratedTextResult,
  ManagedGeneration,
  ModelCallOptions,
  UsageTotals,
} from './types.ts';

export interface GenerationHostOptions {
  defaultModel: LanguageModel;
  usage: UsageTotals;
  abortSignal: AbortSignal;
  timeoutMs?: number | undefined;
  onGeneration?: (trace: import('./types.ts').GenerationTrace) => void;
}

export class GenerationHost implements ManagedGeneration {
  readonly #options: GenerationHostOptions;

  constructor(options: GenerationHostOptions) {
    this.#options = options;
  }

  generateText = async (options: ModelCallOptions): Promise<GeneratedTextResult> => {
    const result = await this.#tracked(options, false, () => generateText(this.#callOptions(options)));
    this.#account(result.totalUsage);
    return { text: result.text, finishReason: result.finishReason };
  };

  generateObject = async <OBJECT>(
    options: ModelCallOptions & { schema: any; name?: string; description?: string },
  ): Promise<GeneratedObjectResult<OBJECT>> => {
    const { schema, name, description, ...rest } = options;
    const result = await this.#tracked({ ...rest, purpose: options.purpose ?? name }, true, () => generateText({
      ...this.#callOptions(rest),
      output: Output.object<OBJECT>({ schema, name, description }),
    }));
    this.#account(result.totalUsage);
    if (result.output === undefined) {
      throw new HarnessError('Structured generation produced no object.');
    }
    return { object: result.output, text: result.text };
  };

  async #tracked<T extends { totalUsage: { inputTokens?: number; outputTokens?: number; outputTokenDetails?: { reasoningTokens?: number } } }>(options: ModelCallOptions, structured: boolean, run: () => Promise<T>): Promise<T> {
    const start = performance.now();
    const emit = (detail: Partial<import('./types.ts').GenerationTrace>) => {
      try { this.#options.onGeneration?.({ purpose: options.purpose ?? (structured ? 'structured' : 'response'), structured, ms: Math.round(performance.now() - start), status: 'success', ...detail }); } catch { /* Diagnostics must not change execution. */ }
    };
    try {
      mergeSignals(this.#options.abortSignal, options.abortSignal).throwIfAborted();
      const result = await run();
      emit({ inputTokens: result.totalUsage.inputTokens, outputTokens: result.totalUsage.outputTokens, reasoningTokens: result.totalUsage.outputTokenDetails?.reasoningTokens });
      return result;
    } catch (error) {
      emit({ status: 'error', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  #callOptions(options: ModelCallOptions) {
    const signal = mergeSignals(this.#options.abortSignal, options.abortSignal);
    const timeout = options.timeoutMs ?? this.#options.timeoutMs;
    return {
      model: options.model ?? this.#options.defaultModel,
      system: options.system,
      prompt: options.prompt,
      messages: options.messages,
      abortSignal: signal,
      maxOutputTokens: options.maxOutputTokens,
      temperature: options.temperature,
      ...(timeout === undefined ? {} : { timeout: { totalMs: timeout } }),
    } as Parameters<typeof generateText>[0];
  }

  #account(usage: { inputTokens?: number | undefined; outputTokens?: number | undefined }): void {
    const bucket = this.#options.usage.model;
    bucket.calls += 1;
    bucket.inputTokens += usage.inputTokens ?? 0;
    bucket.outputTokens += usage.outputTokens ?? 0;
  }
}

export function mergeSignals(
  primary: AbortSignal,
  secondary: AbortSignal | undefined,
): AbortSignal {
  if (secondary === undefined) return primary;
  return AbortSignal.any([primary, secondary]);
}
