/**
 * Errors the assistant is allowed to see.
 *
 * A tool turns a `DomainError` into a structured tool result so the model can
 * correct itself (wrong project name, duplicate, illegal transition). Anything
 * else is an internal fault: it gets logged server-side and reported to the
 * model as an opaque failure, so implementation details never reach the chat.
 */
export type DomainErrorCode = "not_found" | "conflict" | "invalid_input" | "precondition_failed";

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The referenced entity does not exist. */
export class NotFoundError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("not_found", message, details);
  }
}

/** The write would break a uniqueness or exclusivity invariant. */
export class ConflictError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("conflict", message, details);
  }
}

/** Input passed schema validation but is not acceptable to the domain. */
export class InvalidInputError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("invalid_input", message, details);
  }
}

/** The operation is well formed but the current state forbids it. */
export class PreconditionFailedError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("precondition_failed", message, details);
  }
}
