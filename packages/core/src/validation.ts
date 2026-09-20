import { Ajv, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { asSchema, safeValidateTypes } from '@ai-sdk/provider-utils';
import type { RegisteredTool } from './tool.ts';
import type { JsonValue } from './json.ts';

const validator = new Ajv({ strict: false, allErrors: true, validateFormats: true });

addFormats(validator);

const compiled = new WeakMap<RegisteredTool, ValidateFunction>();

/** SDK JSON schemas without a validate callback must still be checked at execution. */
export async function validateInput(tool: RegisteredTool, input: JsonValue) {
  const schema = asSchema(tool.inputSchema);

  if (schema.validate !== undefined) return safeValidateTypes({ value: input, schema });

  try {
    let validate = compiled.get(tool);

    if (validate === undefined) {
      validate = validator.compile(await schema.jsonSchema);
      compiled.set(tool, validate);
    }

    if (validate(input)) return { success: true as const, value: input };

    return { success: false as const, error: new Error(validator.errorsText(validate.errors)) };
  } catch (error) {
    return { success: false as const, error: error instanceof Error ? error : new Error(String(error)) };
  }
}
