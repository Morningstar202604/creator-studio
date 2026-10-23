export type ModelErrorCode =
  | 'MODEL_AUTH'
  | 'MODEL_RATE_LIMITED'
  | 'MODEL_TIMEOUT'
  | 'MODEL_NETWORK'
  | 'MODEL_BAD_RESPONSE'
  | 'MODEL_CONTEXT_OVERFLOW'
  | 'MODEL_UNAVAILABLE'
  | 'BUDGET_EXCEEDED';

export class ModelError extends Error {
  readonly code: ModelErrorCode;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly providerMessage: string | null;

  constructor(
    code: ModelErrorCode,
    message: string,
    options: { retryable?: boolean; status?: number | null; providerMessage?: string | null } = {},
  ) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? null;
    this.providerMessage = options.providerMessage ?? null;
  }
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/g,
  /[A-Za-z0-9_-]{32,}/g,
];

export function redact(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

export function truncate(input: string, max = 500): string {
  const redacted = redact(input);
  return redacted.length <= max ? redacted : `${redacted.slice(0, max)}…`;
}
