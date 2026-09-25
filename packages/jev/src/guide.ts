import { choice, noul } from '@typesafe-ai/sdk';
import type { ChoiceResponse, JsonValue, NoulResponse, Questions, Usage } from '@typesafe-ai/sdk';
import type { AvailableTool, CallRecord, UsageBucket } from '@keeled/core';

/**
 * The tool guide indexes the agent instructions against the tool catalog once. Code splits
 * the instructions into numbered segments; Jev points to segment numbers, so a rule in the
 * guide is always a quote of the instructions, never generated text. For each tool the guide
 * records the segments that govern when to call it, and which other tool usually supplies
 * each required input. It adds context to tool selection; it never removes any.
 */
export interface InstructionSegment {
  id: string;
  text: string;
  /** Headings and lead-in lines above the segment, outermost first. */
  context: string[];
}

export interface ToolRule {
  segment: string;
  /** Jev's probability that the segment sets a rule for the tool. */
  probability: number;
}

export interface InputSource {
  parameter: string;
  /** A tool name, or `userSource` when the user or the conversation supplies the value. */
  source: string;
  probability: number;
}

export interface ToolGuideEntry {
  tool: string;
  /** Jev's probability that any segment sets a rule for the tool. */
  governed: number;
  rules: ToolRule[];
  sources: InputSource[];
}

export interface ToolGuide {
  key: string;
  segments: InstructionSegment[];
  tools: ToolGuideEntry[];
  usage: UsageBucket;
}

export interface ToolGuideOptions {
  /** In shortlist mode, below this probability no segment is taken to govern a tool. Default 0.35. */
  governedFloor?: number;
  /** At or above this probability a segment counts as a rule for a tool. Default 0.5. */
  ruleFloor?: number;
  /** At or above this probability a tool counts as the source of an input. Default 0.5. */
  sourceFloor?: number;
  /** In shortlist mode, candidate segments checked per tool. Default 8. */
  maxCandidates?: number;
  /**
   * Largest number of tool and segment pairs that are each checked with their own Noul.
   * Above it, a Choice shortlists candidates first. Default 4000.
   */
  pairBudget?: number;
  /** Questions in one Jev request. Default 64. */
  questionsPerRequest?: number;
  /** Jev requests in flight while building. Default 4. */
  concurrency?: number;
  /** Longest segment, in characters, before a line is split at sentence ends. Default 360. */
  segmentChars?: number;
  /**
   * A rule for more than this share of the catalog is left out of tool options, because a rule
   * every option carries cannot separate them. It stays in the guide. Default 0.75.
   */
  sharedRuleShare?: number;
}

export type ResolvedGuideOptions = Required<ToolGuideOptions>;

export function guideOptions(options: ToolGuideOptions = {}): ResolvedGuideOptions {
  return {
    governedFloor: options.governedFloor ?? 0.35,
    ruleFloor: options.ruleFloor ?? 0.5,
    sourceFloor: options.sourceFloor ?? 0.5,
    maxCandidates: options.maxCandidates ?? 8,
    pairBudget: options.pairBudget ?? 4000,
    questionsPerRequest: options.questionsPerRequest ?? 64,
    concurrency: options.concurrency ?? 4,
    segmentChars: options.segmentChars ?? 360,
    sharedRuleShare: options.sharedRuleShare ?? 0.75,
  };
}

/** The input source label for values the user states or the conversation already holds. */
export const userSource = 'from:user';

/** A Choice question accepts at most 255 options. */
const choiceLimit = 250;

const guideVersion = 2;

type Answer = ChoiceResponse | NoulResponse;

export interface GuideAnswers {
  readonly [name: string]: Answer;
}

export type GuideAsk = (
  state: { [key: string]: JsonValue },
  questions: Questions,
) => Promise<{ answers: GuideAnswers; usage: Usage }>;

type CatalogTool = Pick<AvailableTool, 'name' | 'description' | 'risk' | 'required'>;

/**
 * The cache identity of a guide: everything it was built from. It is the full canonical text,
 * not a short hash, so different instructions can never share a guide.
 */
export function guideIdentity(
  instructions: string,
  catalog: readonly CatalogTool[],
  model: string | undefined,
  options: ResolvedGuideOptions,
): string {
  return JSON.stringify([guideVersion, model ?? null, instructions, catalog.map(catalogEntry), options]);
}

/**
 * Splits instructions into citable segments. Markdown headings and lines that end with a
 * colon become context for the lines below them, so a quoted segment keeps its scope. A
 * line longer than `maxChars` is split at sentence ends; a single long sentence stays whole.
 */
export function segmentInstructions(text: string, maxChars = 360): InstructionSegment[] {
  return parseInstructions(text, maxChars).segments;
}

/** The instructions as Jev reads them: headings as written, and each segment on a numbered line. */
export function taggedInstructions(text: string, maxChars = 360): string {
  return parseInstructions(text, maxChars).tagged;
}

interface ParsedInstructions {
  segments: InstructionSegment[];
  tagged: string;
}

function parseInstructions(text: string, maxChars: number): ParsedInstructions {
  const segments: InstructionSegment[] = [];
  const tagged: string[] = [];
  const headings: { level: number; text: string }[] = [];
  const parents: { indent: number; text: string }[] = [];
  let lead: string | undefined;

  const add = (body: string, context: string[]) => {
    for (const part of sentenceGroups(body, maxChars)) {
      const segment = { id: segmentId(segments.length), text: part, context: context.map((entry) => clip(entry, 120)) };
      segments.push(segment);
      tagged.push(`${segment.id}| ${segment.text}`);
    }
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const trimmed = line.trim();

    if (trimmed.length === 0) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);

    if (heading !== null) {
      const level = heading[1]!.length;

      while (headings.length > 0 && headings.at(-1)!.level >= level) headings.pop();
      headings.push({ level, text: heading[2]!.trim() });
      tagged.push(trimmed);
      lead = undefined;
      parents.length = 0;
      continue;
    }

    const item = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    const scope = headings.map((entry) => entry.text);

    if (item === null) {
      parents.length = 0;
      add(trimmed, scope);
      lead = trimmed.endsWith(':') ? trimmed : undefined;
      continue;
    }

    const indent = item[1]!.length;
    const body = item[2]!.trim();

    while (parents.length > 0 && parents.at(-1)!.indent >= indent) parents.pop();
    add(body, [...scope, ...(lead === undefined ? [] : [lead]), ...parents.map((parent) => parent.text)]);
    parents.push({ indent, text: body });
  }

  return { segments, tagged: tagged.join('\n') };
}

function sentenceGroups(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const groups: string[] = [];
  let current = '';

  for (const sentence of text.split(/(?<=[.!?])\s+(?=\S)/)) {
    if (current.length > 0 && current.length + 1 + sentence.length > maxChars) {
      groups.push(current);
      current = sentence;
    } else {
      current = current.length === 0 ? sentence : `${current} ${sentence}`;
    }
  }

  if (current.length > 0) groups.push(current);

  return groups;
}

function segmentId(index: number): string {
  return `I${String(index).padStart(3, '0')}`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A segment with its scope, as quoted in a tool option. */
export function quoteSegment(segment: InstructionSegment): string {
  return segment.context.length === 0 ? segment.text : `${segment.context.join(' › ')} › ${segment.text}`;
}

/**
 * Builds the guide in two passes. The first asks, for each tool, whether any segment governs
 * it (a Noul), and which tool supplies each required input (a Choice). The second pass checks
 * segments with one Noul each, because a Noul does not depend on the other options.
 *
 * When the catalog and instructions give at most `pairBudget` pairs, every segment is checked
 * for every tool. Jev's Choice concentrates on one answer, so a Choice shortlist finds only the
 * one or two most direct rules of a tool; the shortlist is the fallback for larger inputs, and
 * there the first-pass Noul gates which tools are checked at all.
 */
export async function buildGuide(
  ask: GuideAsk,
  key: string,
  instructions: string,
  catalog: readonly CatalogTool[],
  options: ResolvedGuideOptions,
): Promise<ToolGuide> {
  const { segments, tagged } = parseInstructions(instructions, options.segmentChars);
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  const order = new Map(segments.map((segment, index) => [segment.id, index]));
  const usage: UsageBucket = { calls: 0, inputTokens: 0, outputTokens: 0 };

  const state = {
    instructions: tagged,
    tools: catalog.map(catalogEntry),
  };

  const windows: InstructionSegment[][] = [];

  for (let start = 0; start < segments.length; start += choiceLimit) {
    windows.push(segments.slice(start, start + choiceLimit));
  }

  const exhaustive = catalog.length * segments.length <= options.pairBudget;
  const first: Questions = {};

  for (const [index, tool] of catalog.entries()) {
    if (segments.length > 0) {
      first[`g${index}`] = noul(
        `Does any numbered instruction segment set a rule for the tool "${tool.name}": when the agent should call it, what must be done or known before calling it, or whether it may run?`,
        {
          true: 'At least one segment states or directly implies such a rule for this tool, or for a kind of action it performs.',
          false: 'No segment sets a rule for calling this tool.',
        },
      );

      for (const [position, window] of windows.entries()) {
        if (exhaustive || window.length < 2) continue;
        first[`w${index}_${position}`] = choice(
          `Which numbered instruction segment most directly sets a rule for the tool "${tool.name}": when to call it, what must come before it, or whether it may run?`,
          Object.fromEntries(window.map((segment) => [segment.id, null])),
        );
      }
    }

    const others = catalog.filter((other) => other.name !== tool.name);

    if (others.length === 0) continue;

    for (const [position, parameter] of tool.required.entries()) {
      first[`s${index}_${position}`] = choice(
        `Where does the agent normally get the value of the required input "${parameter}" of the tool "${tool.name}"?`,
        {
          ...Object.fromEntries(others.map((other) => [other.name, `Returned by ${other.name}: ${other.description}`])),
          [userSource]:
            'The user states it, or it is already in the conversation or the instructions; no tool returns it.',
        },
      );
    }
  }

  const answers = await askAll(ask, state, first, options, usage);
  const entries: ToolGuideEntry[] = [];
  const second: Questions = {};
  const pending: { tool: number; segment: string }[] = [];

  for (const [index, tool] of catalog.entries()) {
    const governed = noulOf(answers[`g${index}`]);

    const sources = tool.required.flatMap((parameter, position) => {
      const answer = answers[`s${index}_${position}`];

      if (answer === undefined || answer.type !== 'choice') return [];

      return [{ parameter, source: answer.choice, probability: answer.probabilities[answer.choice] ?? 0 }];
    });

    entries.push({ tool: tool.name, governed, rules: [], sources });

    if (segments.length === 0 || (!exhaustive && governed < options.governedFloor)) continue;

    const checked = exhaustive
      ? segments.map((segment) => segment.id)
      : candidates(answers, index, windows, options.maxCandidates);

    for (const segment of checked) {
      const found = byId.get(segment);

      if (found === undefined) continue;
      const quoted = quoteSegment(found);
      const name = `r${pending.length}`;
      pending.push({ tool: index, segment });
      second[name] = noul(
        `Does instruction segment ${segment} set a rule for the tool "${tool.name}": when to call it, what must be done or known before calling it, or whether it may run? Segment ${segment}: "${quoted}"`,
        {
          true: 'The segment states or directly implies such a rule for this tool, or for a kind of action it performs.',
          false: 'The segment is about something else, or mentions the tool only in passing.',
        },
      );
    }
  }

  const confirmations = await askAll(ask, state, second, options, usage);

  for (const [position, { tool, segment }] of pending.entries()) {
    const probability = noulOf(confirmations[`r${position}`]);

    if (probability >= options.ruleFloor) entries[tool]!.rules.push({ segment, probability });
  }

  // Document order keeps sequences such as "first ..., then ..." readable.
  for (const entry of entries) entry.rules.sort((left, right) => order.get(left.segment)! - order.get(right.segment)!);

  return { key, segments, tools: entries, usage };
}

/** The highest-ranked segments for a tool across every window, best first. */
function candidates(
  answers: GuideAnswers,
  tool: number,
  windows: readonly InstructionSegment[][],
  limit: number,
): string[] {
  const ranked: { segment: string; probability: number }[] = [];

  for (const [position, window] of windows.entries()) {
    const answer = answers[`w${tool}_${position}`];

    if (window.length === 1) ranked.push({ segment: window[0]!.id, probability: 1 });

    if (answer === undefined || answer.type !== 'choice') continue;

    for (const [segment, probability] of Object.entries(answer.probabilities)) {
      if (probability > 0) ranked.push({ segment, probability });
    }
  }

  return ranked
    .sort((left, right) => right.probability - left.probability)
    .slice(0, limit)
    .map((entry) => entry.segment);
}

function noulOf(answer: Answer | undefined): number {
  return answer !== undefined && answer.type === 'noul' ? answer.noul : 0;
}

async function askAll(
  ask: GuideAsk,
  state: { [key: string]: JsonValue },
  questions: Questions,
  options: ResolvedGuideOptions,
  usage: UsageBucket,
): Promise<{ [name: string]: Answer }> {
  const names = Object.keys(questions);
  const batches: Questions[] = [];

  for (let start = 0; start < names.length; start += options.questionsPerRequest) {
    batches.push(
      Object.fromEntries(
        names.slice(start, start + options.questionsPerRequest).map((name) => [name, questions[name]!]),
      ),
    );
  }

  const answers: { [name: string]: Answer } = {};
  let next = 0;

  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next]!;
      next += 1;
      const result = await ask(state, batch);
      usage.calls += 1;
      usage.inputTokens += result.usage.input_tokens ?? 0;
      usage.outputTokens += result.usage.output_tokens ?? 0;
      Object.assign(answers, result.answers);
    }
  };

  await Promise.all(Array.from({ length: Math.min(options.concurrency, batches.length) }, worker));

  return answers;
}

function catalogEntry(tool: CatalogTool) {
  return { name: tool.name, description: tool.description, risk: tool.risk, required: [...tool.required] };
}

/**
 * The guide's note for one tool option: the instruction segments that govern it, and which
 * tools supply its inputs with whether each has returned a result in this conversation.
 */
export function guideNote(
  tool: string,
  guide: ToolGuide,
  history: readonly CallRecord[],
  options: ResolvedGuideOptions,
): string {
  const entry = guide.tools.find((candidate) => candidate.tool === tool);

  if (entry === undefined) return '';
  const byId = new Map(guide.segments.map((segment) => [segment.id, segment]));
  const parts: string[] = [];
  const shared = sharedRules(guide, options.sharedRuleShare);
  const included = entry.rules.flatMap((rule) => (shared.has(rule.segment) ? [] : (byId.get(rule.segment) ?? [])));
  // A lead-in line already quoted as the scope of another rule is not repeated.
  const scopes = new Set(included.flatMap((segment) => segment.context));

  const rules = included.flatMap((segment) =>
    scopes.has(clip(segment.text, 120)) ? [] : [`[${segment.id}] ${quoteSegment(segment)}`],
  );

  if (rules.length > 0) parts.push(`Instructions for this tool: ${rules.join(' | ')}`);

  const inputs = entry.sources.flatMap((source) => {
    if (source.source === userSource || source.source === tool || source.probability < options.sourceFloor) return [];

    return [`"${source.parameter}" usually comes from ${source.source} (${status(source.source, history)})`];
  });

  if (inputs.length > 0) parts.push(`Inputs: ${inputs.join('; ')}.`);

  return parts.length === 0 ? '' : ` ${parts.join(' ')}`;
}

/** Segments that are rules for more than `share` of the catalog, with at least three tools. */
export function sharedRules(guide: ToolGuide, share: number): Set<string> {
  const counts = new Map<string, number>();

  for (const entry of guide.tools) {
    for (const rule of entry.rules) counts.set(rule.segment, (counts.get(rule.segment) ?? 0) + 1);
  }

  const limit = Math.max(2, share * guide.tools.length);

  return new Set([...counts].flatMap(([segment, count]) => (count > limit ? [segment] : [])));
}

function status(tool: string, history: readonly CallRecord[]): string {
  const calls = history.filter((call) => call.tool === tool);

  if (calls.some((call) => call.outcome === 'result')) return 'it has returned a result in this conversation';

  if (calls.length > 0) return 'its calls so far have failed';

  return 'not called yet in this conversation';
}
