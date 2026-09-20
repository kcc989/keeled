import { z } from 'zod';
import { agentTool } from './tool.ts';
import { callHistory } from './projection.ts';
import { calculateDecimals } from './arithmetic.ts';
import { jsonObject, type JsonValue } from './json.ts';

/** Arithmetic operands are copied from successful evidence, not invented by a model. */
export function evidenceCalculationTool() {
  return agentTool({
    description:
      'Perform exact decimal arithmetic over values in successful stored tool results. Each operand uses a result reference and property/index path. Difference is first minus second. Compare returns -1, 0, or 1. Applications must supply normalized units; do not mix incompatible quantities.',
    risk: 'read',
    repeat: 'reuse',
    inputSchema: z.object({
      operation: z.enum(['sum', 'difference', 'compare', 'product']),
      operands: z
        .array(z.object({ ref: z.string(), path: z.array(z.union([z.string(), z.number().int().min(0)])) }))
        .min(1)
        .max(1000),
    }),
    execute: (input, context) => {
      const history = callHistory(context.conversation, context.state.observations);

      const operands = input.operands.map((operand) => {
        const result = history.find((call) => call.ref === operand.ref && call.outcome === 'result');

        if (!result) throw new Error(`No successful result ${operand.ref}.`);
        let value: JsonValue = result.result;

        for (const key of operand.path) {
          if (Array.isArray(value) && isIndex(key) && Object.hasOwn(value, key)) value = value[key];
          else {
            const object = jsonObject(value);

            if (object === undefined || !Object.hasOwn(object, key)) throw new Error('Operand path is missing.');
            value = object[key];
          }
        }

        return { ...operand, value };
      });

      return {
        operation: input.operation,
        operands,
        result: calculateDecimals(
          input.operation,
          operands.map((operand) => operand.value),
        ),
      };
    },
  });
}

function isIndex(value: string | number): value is number {
  return typeof value === 'number';
}
