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
}

export class GenerationHost implements ManagedGeneration {
  readonly #options: GenerationHostOptions;

  constructor(options: GenerationHostOptions) {
    this.#options = options;
  }

  generateText = async (options: ModelCallOptions): Promise<GeneratedTextResult> => {
    const result = await generateText(this.#callOptions(options));
    this.#account(result.totalUsage);
    return { text: result.text, finishReason: result.finishReason };
  };

  generateObject = async <OBJECT>(
    options: ModelCallOptions & { schema: any; name?: string; description?: string },
  ): Promise<GeneratedObjectResult<OBJECT>> => {
    const { schema, name, description, ...rest } = options;
    const result = await generateText({
      ...this.#callOptions(rest),
      output: Output.object<OBJECT>({ schema, name, description }),
    });
    this.#account(result.totalUsage);
    if (result.output === undefined) {
      throw new HarnessError('Structured generation produced no object.');
    }
    return { object: result.output, text: result.text };
  };

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
