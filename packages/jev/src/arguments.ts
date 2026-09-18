import type { TypeSafeClient, ChoiceResponse, JsonValue, NoulResponse, Questions } from '@typesafe-ai/sdk';
import { choice, noul } from '@typesafe-ai/sdk';
import type { Fact, FactRecord } from '@keeled/core';
import { grade } from './controller.ts';

export interface ArgumentQuestion {
  /** A stable key for the parameter, such as `reservation_id` or `flights.0.date`. */
  key: string;
  /** The parameter name as the tool knows it. */
  name: string;
  description?: string;
  candidates: readonly Fact[];
}

/**
 * Parameters that belong together, such as a flight's number and date, filled from one
 * record. Each field is copied from the chosen record by name, so values from different
 * records cannot be combined into one argument set.
 */
export interface RecordGroup {
  /** A stable key for the group, such as `call` or `flights.0`. */
  key: string;
  fields: readonly { key: string; name: string }[];
  records: readonly FactRecord[];
}

export interface ArgumentChoiceOptions {
  client: TypeSafeClient;
  /** The state document Jev evaluates, such as the controller state. */
  state: { [key: string]: JsonValue };
  tool: { name: string; description?: string };
  parameters: readonly ArgumentQuestion[];
  /** Groups of parameters to fill from one record each. Their fields are not asked singly. */
  groups?: readonly RecordGroup[];
  /** How confident the choice must be. Defaults to 0.5. */
  choiceFloor?: number;
  /** How confident the "value is listed" judgement must be. Defaults to 0.6. */
  listedFloor?: number;
  /** Probability above which a noul answer counts as true. Defaults to 0.5. */
  noulThreshold?: number;
  model?: string;
  signal?: AbortSignal;
  /** At most this many candidates are offered per parameter, in index order. Defaults to 24. */
  maxCandidates?: number;
}

export type Abstention = 'no_candidates' | 'chose_none' | 'not_listed' | 'low_confidence';

export interface ArgumentPick {
  key: string;
  /** The chosen value, or undefined when Jev declined every candidate. */
  value?: string | number;
  abstained?: Abstention;
  choice?: { choice: string; confidence: number; probabilities: Record<string, number> };
  listed?: { value: boolean; confidence: number };
  /** For a field filled from a record, the record chosen. */
  record?: string;
}

const none = 'none';

/**
 * Asks Jev to fill tool arguments from established facts, in one request. Each parameter
 * gets a choice over its candidates that includes an explicit "none of these", and a
 * separate judgement of whether the correct value is listed at all. That second question
 * does not compete with the candidates, so a field of poor candidates cannot hide a "no".
 * A value is used only when the choice names a candidate with enough confidence and the
 * value is judged listed; otherwise the parameter is left to the model.
 */
export async function chooseArguments(options: ArgumentChoiceOptions): Promise<ArgumentPick[]> {
  const choiceFloor = options.choiceFloor ?? 0.5;
  const listedFloor = options.listedFloor ?? 0.6;
  const threshold = options.noulThreshold ?? 0.5;
  const limit = options.maxCandidates ?? 24;
  const tool = `${options.tool.name}${options.tool.description === undefined ? '' : ` (${options.tool.description})`}`;

  const questions: Questions = {};
  const offered = new Map<string, Map<string, Fact>>();
  for (const parameter of options.parameters) {
    const byOption = new Map<string, Fact>();
    for (const fact of parameter.candidates) {
      if (byOption.size >= limit) break;
      const option = String(fact.value);
      if (option !== none && !byOption.has(option)) byOption.set(option, fact);
    }
    if (byOption.size === 0) continue;
    offered.set(parameter.key, byOption);

    const what = `"${parameter.name}"${parameter.description === undefined ? '' : ` (${parameter.description})`}`;
    const criteria: Record<string, string> = {};
    for (const [option, fact] of byOption) criteria[option] = `${fact.value}: ${fact.label}`;
    criteria[none] =
      'None of these. The correct value is not listed: it has not been established yet, must be computed, ' +
      'or is something else.';
    questions[`${parameter.key}::value`] = choice(`Which value should the ${tool} call use for ${what}?`, criteria);
    questions[`${parameter.key}::listed`] = noul(
      `Is the correct value for ${what} in the ${tool} call exactly one of: ${[...byOption.keys()].join(', ')}?`,
      {
        true: 'The correct value appears in that list exactly as written.',
        false: 'The correct value is not in that list: it must come from elsewhere or be computed.',
      },
    );
  }

  const grouped = new Map<string, Map<string, FactRecord>>();
  for (const group of options.groups ?? []) {
    const byOption = new Map<string, FactRecord>();
    for (const record of group.records.slice(0, limit)) byOption.set(`record_${byOption.size + 1}`, record);
    if (byOption.size === 0) continue;
    grouped.set(group.key, byOption);
    const names = group.fields.map(field => `"${field.name}"`).join(', ');
    const criteria: Record<string, string> = {};
    for (const [option, record] of byOption) criteria[option] = record.label;
    criteria[none] =
      'None of these. No listed record has the right combination: it has not been established yet, must be ' +
      'computed, or comes from what the user asked for.';
    questions[`${group.key}::record`] = choice(`Which record supplies ${names} for the ${tool} call?`, criteria);
    questions[`${group.key}::record_listed`] = noul(
      `Is the correct combination of ${names} for the ${tool} call exactly one of the listed records?`,
      {
        true: 'One listed record has exactly the right values for all of these together.',
        false: 'No listed record has the right combination; the values must come from elsewhere.',
      },
    );
  }

  const picks: ArgumentPick[] = options.parameters
    .filter(parameter => !offered.has(parameter.key))
    .map(parameter => ({ key: parameter.key, abstained: 'no_candidates' }));
  for (const group of options.groups ?? []) {
    if (!grouped.has(group.key)) picks.push(...group.fields.map(field => ({ key: field.key, abstained: 'no_candidates' as const })));
  }
  if (offered.size === 0 && grouped.size === 0) return picks;

  const result = await options.client.systemOne(
    { state: options.state, questions, ...(options.model === undefined ? {} : { model: options.model }) },
    { signal: options.signal },
  );
  const answers = result.answers as unknown as Record<string, ChoiceResponse | NoulResponse>;

  for (const [key, byOption] of offered) {
    const picked = answers[`${key}::value`] as unknown as ArgumentPick['choice'];
    const graded = grade(answers[`${key}::listed`] as NoulResponse | undefined, threshold);
    const listed = { value: graded.complete, confidence: graded.confidence };
    const base: ArgumentPick = { key, ...(picked === undefined ? {} : { choice: picked }), listed };

    let abstained: Abstention | undefined;
    if (picked === undefined || picked.choice === none || !byOption.has(picked.choice)) abstained = 'chose_none';
    else if (!listed.value) abstained = 'not_listed';
    else if (picked.confidence < choiceFloor || listed.confidence < listedFloor) abstained = 'low_confidence';

    picks.push(abstained === undefined ? { ...base, value: byOption.get(picked!.choice)!.value } : { ...base, abstained });
  }

  for (const group of options.groups ?? []) {
    const byOption = grouped.get(group.key);
    if (byOption === undefined) continue;
    const picked = answers[`${group.key}::record`] as unknown as ArgumentPick['choice'];
    const graded = grade(answers[`${group.key}::record_listed`] as NoulResponse | undefined, threshold);
    const listed = { value: graded.complete, confidence: graded.confidence };
    const record = picked === undefined ? undefined : byOption.get(picked.choice);

    let abstained: Abstention | undefined;
    if (record === undefined) abstained = 'chose_none';
    else if (!listed.value) abstained = 'not_listed';
    else if (picked!.confidence < choiceFloor || listed.confidence < listedFloor) abstained = 'low_confidence';

    for (const field of group.fields) {
      const base: ArgumentPick = {
        key: field.key,
        ...(picked === undefined ? {} : { choice: picked }),
        listed,
        ...(record === undefined ? {} : { record: record.label }),
      };
      picks.push(abstained === undefined ? { ...base, value: record!.fields[field.name] } : { ...base, abstained });
    }
  }
  return picks;
}
