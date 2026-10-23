export type AuditDecision = 'allow' | 'ask' | 'deny';

export type AuditRecord = {
  id: string;
  ts: string;
  deviceId: string;
  runId: string | null;
  tool: string;
  target: string;
  decision: AuditDecision;
  reason: string;
  durationMs: number;
  ok: boolean;
  errorCode: string | null;
};

export type AuditSink = {
  write(record: AuditRecord): void | Promise<void>;
  all(): AuditRecord[];
};

export class MemoryAuditSink implements AuditSink {
  private readonly records: AuditRecord[] = [];

  write(record: AuditRecord): void {
    this.records.push(record);
  }

  all(): AuditRecord[] {
    return [...this.records];
  }
}

let counter = 0;

export function nextAuditId(): string {
  counter += 1;
  return `audit_${Date.now().toString(36)}_${counter.toString(36)}`;
}
