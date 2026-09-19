import { TypeSafeClient, choice, noul } from '@typesafe-ai/sdk';
import type { ChoiceResponse, EntryType, NoulResponse, Questions, Usage } from '@typesafe-ai/sdk';
import type { ObservedArgumentJudge, ObservedArgumentQuery } from '@keeled/core';

export interface ObservedArgumentTrace {
  query: ObservedArgumentQuery;
  selectedDomain?: string;
  selectedOptions: readonly string[];
  sourceConfidence: number;
  usage: Usage;
  ms: number;
}

export interface JevObservedArgumentOptions {
  client?: TypeSafeClient;
  model?: string;
  sourceConfidenceFloor?: number;
  membershipThreshold?: number;
  onJudgment?: (trace: ObservedArgumentTrace) => void;
}

/**
 * Treats values observed at runtime as temporary closed sets. Jev interprets which set and
 * members the request means; core copies the selected values and validates the resulting calls.
 */
export function jevObservedArguments(options: JevObservedArgumentOptions = {}): ObservedArgumentJudge {
  const client = options.client ?? new TypeSafeClient();
  const sourceFloor = options.sourceConfidenceFloor ?? 0.5;
  const membershipThreshold = options.membershipThreshold ?? 0.5;

  return async (query, context) => {
    const sourceCriteria: Record<string, string> = {
      none_fit: 'None of the observed value sets supplies this argument. Do not force an unrelated value to fit.',
    };
    const questions: Questions = {};
    for (const domain of query.domains) {
      const examples = domain.options.slice(0, 5).map(option => option.description).join(' ');
      sourceCriteria[domain.id] = `${domain.description} ${examples}`;
      for (const option of domain.options) {
        questions[`member:${option.id}`] = noul(
          `Assuming values from ${domain.path} identify the kind of thing accepted by ${query.tool.name}, does the user's request include the specific observed item ${option.description}?`,
          {
            true: 'The request asks for this item, or asks for every item in the collection that contains it.',
            false: 'The request excludes this item, selects a different item, or does not identify it.',
          },
        );
      }
    }
    questions['source'] = choice(
      `Which observed value set supplies the ${query.tool.name} argument used to ${query.tool.description}? Select by meaning and role, not by spelling similarity.`,
      sourceCriteria,
    );

    const started = performance.now();
    const result = await client.systemOne({
      state: {
        user_request: query.request,
        tool: query.tool,
        argument: query.argument,
        observed_domains: query.domains,
      } as unknown as EntryType,
      questions,
      ...(options.model === undefined ? {} : { model: options.model }),
    }, { signal: context.abortSignal });
    const answers = result.answers as unknown as Record<string, ChoiceResponse | NoulResponse>;
    const source = answers['source'] as ChoiceResponse | undefined;
    const selectedDomain = source?.choice === 'none_fit' || (source?.confidence ?? 0) < sourceFloor
      ? undefined
      : source?.choice;
    const domain = query.domains.find(item => item.id === selectedDomain);
    // Once Jev has selected a source domain, its only member is the only accepted value.
    // Membership questions are useful only when the observed closed set has alternatives.
    const selectedOptions = domain?.options.length === 1
      ? [domain.options[0]!.id]
      : domain?.options
        .filter(option => ((answers[`member:${option.id}`] as NoulResponse | undefined)?.noul ?? 0) >= membershipThreshold)
        .map(option => option.id) ?? [];
    options.onJudgment?.({
      query,
      ...(selectedDomain === undefined ? {} : { selectedDomain }),
      selectedOptions,
      sourceConfidence: source?.confidence ?? 0,
      usage: result.usage,
      ms: Math.round(performance.now() - started),
    });
    return { ...(selectedDomain === undefined ? {} : { domainId: selectedDomain }), optionIds: selectedOptions };
  };
}
