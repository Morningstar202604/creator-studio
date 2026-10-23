export type DomainErrorCode =
  | 'RUN_ALREADY_HAS_RUNNING_STEP'
  | 'APPROVAL_REQUIRED'
  | 'BUDGET_EXCEEDED'
  | 'INVALID_TRANSITION'
  | 'UNKNOWN_AGENT';

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'DomainError';
    this.code = code;
  }
}
