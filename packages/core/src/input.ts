import { jsonSchema, type LanguageModel } from 'ai';
import { MissingInformation } from './errors.ts';
import { callHistory } from './projection.ts';
import { isJsonValue, jsonObject, type JsonValue } from './json.ts';
import type { AgentContext } from './tool.ts';
import { decisionContext } from './context.ts';

type JsonSchema = Parameters<typeof jsonSchema>[0];

/** Argument binding is separate from action selection and permission checks. */
export const argumentBindingInstructions =
  'The controller has selected this tool for this step. Bind its input schema using the request and observed evidence. ' +
  'A lookup may supply a prerequisite for the larger request; it need not perform the entire requested outcome. ' +
  'Do not choose a different tool or decide whether this action is permitted or confirmed. The runtime checks ' +
  'authorization, confirmation, and repeat policy separately after binding. Ready arguments do not authorize execution. ' +
  'Copy exact supported values, preserving their record and source scope. Never invent values, user constraints, ' +
  'or placeholders. If a required value is unavailable or ambiguous, identify that value rather than substituting one.';

export async function resolveToolInput(
  spec: { name: string; description: string; parameters: JsonSchema },
  context: AgentContext,
  model: LanguageModel | undefined,
): Promise<JsonValue> {
  const properties = isJsonValue(spec.parameters) ? jsonObject(jsonObject(spec.parameters)?.['properties']) : undefined;

  if (properties === undefined || Object.keys(properties).length === 0) return {};

  const action = context.action;

  const earlier = callHistory(context.conversation, context.state.observations).filter(
    (call) => call.tool === spec.name,
  );

  const { object } = await context.generateObject<Resolution>({
    model,
    schema: resolutionSchema(spec.parameters),
    name: spec.name,
    purpose: 'tool_input',
    description: spec.description,
    system:
      argumentBindingInstructions +
      ' Return status "ready" when the arguments are grounded, including when permission or confirmation is still pending. ' +
      'Return status "missing" only when a required argument cannot be grounded; identify the missing or ambiguous ' +
      'field and the evidence needed to fill it. A policy refusal, pending confirmation, or previously used input is not a missing argument.',
    prompt: [
      await decisionContext(context, `Resolve arguments for ${spec.name}: ${spec.description}`),
      `Tool:\n${spec.name} — ${spec.description}`,
      earlier.length === 0
        ? `Earlier calls of ${spec.name}: none.`
        : `Earlier calls of ${spec.name}:\n` +
          earlier
            .map(
              (call) =>
                `- [${call.ref}] input ${JSON.stringify(call.input)} ${call.outcome === 'result' ? 'returned a result' : 'failed'}`,
            )
            .join('\n'),
      ...(action?.awaitingInput === undefined
        ? []
        : [
            `This action is awaiting the user's confirmation with input ${JSON.stringify(action.awaitingInput)}. ` +
              'If the user confirmed it unchanged, return exactly this input.',
          ]),
      `Input JSON schema:\n${JSON.stringify(spec.parameters)}`,
    ].join('\n\n'),
  });

  if (object.status === 'missing') throw new MissingInformation(object.missing?.trim() || 'unspecified information');

  const arguments_ = object.arguments ?? {};

  if (!isJsonValue(arguments_)) throw new MissingInformation('tool input was not JSON-serializable');

  return arguments_;
}

interface Resolution {
  status: 'ready' | 'missing';
  arguments?: JsonValue;
  missing?: string;
}

/**
 * The tool's input schema wrapped so the model can decline: `ready` with arguments, or
 * `missing` with what is needed. The tool's definitions move to the root, where its
 * references point.
 */
function resolutionSchema(parameters: JsonSchema) {
  const object = isJsonValue(parameters) ? jsonObject(parameters) : undefined;
  const { $defs, ...input } = object ?? {};

  // SAFETY: the adjacent validation or framework contract establishes the asserted type.
  return jsonSchema<Resolution>({
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['ready', 'missing'] },
      arguments: input,
      missing: {
        type: 'string',
        description:
          'When status is "missing": which required input field cannot be grounded, and what evidence would resolve it.',
      },
    },
    required: ['status'],
    $defs,
  } as JsonSchema);
}
