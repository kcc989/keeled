export class HarnessError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ConfigurationError extends HarnessError {}

export class ToolRegistrationError extends ConfigurationError {}

export class PlanValidationError extends HarnessError {}

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

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
