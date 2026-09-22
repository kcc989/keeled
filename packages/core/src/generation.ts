import { NoObjectGeneratedError, Output, generateText, jsonSchema, tool } from 'ai';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import { HarnessError } from './errors.ts';
import { isJsonValue, type JsonValue } from './json.ts';
import type {
  GeneratedObjectResult,
  GeneratedTextResult,
  GeneratedToolCall,
  GeneratedToolCallsResult,
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

    const result = await this.#tracked(
      { ...rest, purpose: options.purpose ?? name },
      true,
      () =>
        generateText({
          ...this.#callOptions(rest),
          output: Output.object<OBJECT>({ schema, name, description }),
        }),
      (generated) => {
        // Structured output may be parsed lazily by the SDK. Keep validation in the tracked call.
        if (generated.output === undefined) throw new HarnessError('Structured generation produced no object.');

        return undefined;
      },
    );

    this.#account(result.totalUsage);

    if (result.output === undefined) {
      throw new HarnessError('Structured generation produced no object.');
    }

    return { object: result.output, text: result.text };
  };

  generateToolCalls = async (
    options: ModelCallOptions & { tools: readonly import('./types.ts').ModelToolContract[] },
  ): Promise<GeneratedToolCallsResult> => {
    const { tools: contracts, ...rest } = options;

    const tools = Object.fromEntries(
      contracts.map((contract) => [
        contract.name,
        tool({
          description: contract.description,
          inputSchema: contract.inputSchema,
          outputSchema: jsonSchema({}),
        }),
      ]),
    );

    const result = await this.#tracked(
      rest,
      true,
      () => generateText({ ...this.#callOptions(rest), tools, toolChoice: 'required' }),
      (generated) => ({
        calls: generated.toolCalls.map((call) => ({
          tool: call.toolName,
          input: isJsonValue(call.input) ? call.input : null,
        })),
        finishReason: generated.finishReason,
      }),
    );

    this.#account(result.totalUsage);

    return {
      calls: result.toolCalls.map((call) => {
        const generated: GeneratedToolCall = { tool: call.toolName, input: call.input };

        if ('invalid' in call && call.invalid === true) {
          generated.invalid = true;
          generated.error = call.error instanceof Error ? call.error.message : String(call.error);
        }

        return generated;
      }),
      text: result.text,
      finishReason: result.finishReason,
    };
  };

  async #tracked<
    T extends {
      totalUsage: {
        inputTokens?: number;
        outputTokens?: number;
        inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
        outputTokenDetails?: { reasoningTokens?: number };
      };
    },
  >(
    options: ModelCallOptions,
    structured: boolean,
    run: () => Promise<T>,
    detail?: (result: T) => JsonValue,
  ): Promise<T> {
    const start = performance.now();
    let returnedUsage: T['totalUsage'] | undefined;
    const identity = modelIdentity(options.model ?? this.#options.defaultModel);

    const emit = (detail: Partial<import('./types.ts').GenerationTrace>) => {
      try {
        this.#options.onGeneration?.({
          purpose: options.purpose ?? (structured ? 'structured' : 'response'),
          structured,
          ms: Math.round(performance.now() - start),
          status: 'success',
          ...identity,
          ...detail,
        });
      } catch {
        /* Diagnostics must not change execution. */
      }
    };

    try {
      mergeSignals(this.#options.abortSignal, options.abortSignal).throwIfAborted();
      this.#options.usage.model.calls += 1;
      const result = await run();
      returnedUsage = result.totalUsage;
      emit({
        inputTokens: result.totalUsage.inputTokens,
        cacheReadTokens: result.totalUsage.inputTokenDetails?.cacheReadTokens,
        cacheWriteTokens: result.totalUsage.inputTokenDetails?.cacheWriteTokens,
        outputTokens: result.totalUsage.outputTokens,
        reasoningTokens: result.totalUsage.outputTokenDetails?.reasoningTokens,
        detail: detail?.(result),
      });

      return result;
    } catch (error) {
      const failedUsage = returnedUsage ?? (NoObjectGeneratedError.isInstance(error) ? error.usage : undefined);

      if (failedUsage !== undefined) this.#account(failedUsage);
      emit({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        inputTokens: failedUsage?.inputTokens,
        cacheReadTokens: failedUsage?.inputTokenDetails?.cacheReadTokens,
        cacheWriteTokens: failedUsage?.inputTokenDetails?.cacheWriteTokens,
        outputTokens: failedUsage?.outputTokens,
      });
      throw error;
    }
  }

  #callOptions(options: ModelCallOptions) {
    const signal = mergeSignals(this.#options.abortSignal, options.abortSignal);
    const timeout = options.timeoutMs ?? this.#options.timeoutMs;

    // SAFETY: the adjacent validation or framework contract establishes the asserted type.
    const callOptions = {
      model: options.model ?? this.#options.defaultModel,
      system: options.system,
      prompt: options.prompt,
      messages: options.messages,
      abortSignal: signal,
      maxOutputTokens: options.maxOutputTokens,
      temperature: options.temperature,
    };

    const completeOptions = timeout === undefined ? callOptions : { ...callOptions, timeout: { totalMs: timeout } };

    // SAFETY: callers always supply exactly one AI SDK prompt representation through ModelCallOptions.
    return completeOptions as Parameters<typeof generateText>[0];
  }

  #account(usage: { inputTokens?: number | undefined; outputTokens?: number | undefined }): void {
    const bucket = this.#options.usage.model;
    bucket.inputTokens += usage.inputTokens ?? 0;
    bucket.outputTokens += usage.outputTokens ?? 0;
  }
}

interface ModelIdentity {
  provider?: string;
  modelId?: string;
}

const modelIdentitySchema = z.union([
  z.string().transform((modelId): ModelIdentity => ({ modelId })),
  z
    .object({ provider: z.string(), modelId: z.string() })
    .transform(({ provider, modelId }): ModelIdentity => ({ provider, modelId })),
]);

function modelIdentity(model: LanguageModel): ModelIdentity {
  const parsed = modelIdentitySchema.safeParse(model);

  return parsed.success ? parsed.data : {};
}

export function mergeSignals(primary: AbortSignal, secondary: AbortSignal | undefined): AbortSignal {
  if (secondary === undefined) return primary;

  return AbortSignal.any([primary, secondary]);
}
