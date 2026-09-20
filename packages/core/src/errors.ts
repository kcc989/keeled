export class HarnessError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ConfigurationError extends HarnessError {}

export class ToolRegistrationError extends ConfigurationError {}

export class InputResolutionError extends HarnessError {
  readonly toolName: string;
  constructor(toolName: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.toolName = toolName;
  }
}

export class PersistenceError extends HarnessError {}

export class AgentToolRuntimeError extends HarnessError {
  constructor(toolName: string) {
    super(
      `Tool "${toolName}" was defined with agentTool() and requires the Jev harness runtime. ` +
        `An ordinary AI SDK tool loop cannot supply its execution context.`,
    );
  }
}

export function isAbortError(cause: unknown): boolean {
  if (cause instanceof DOMException && cause.name === 'AbortError') return true;

  return cause instanceof Error && cause.name === 'AbortError';
}

export function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;

  if (isString(cause)) return cause;

  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Thrown by an input resolver that cannot produce input because information is missing.
 * The runtime records it as missing evidence, with the description as what would resolve it,
 * instead of letting the resolver invent values.
 */
export class MissingInformation extends HarnessError {
  readonly missing: string;

  constructor(missing: string) {
    super(`Missing information: ${missing}`);
    this.name = 'MissingInformation';
    this.missing = missing;
  }
}
