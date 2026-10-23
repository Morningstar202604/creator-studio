import type { RunEvent } from '@creator-studio/protocol';

export type EventListener = (event: RunEvent) => void;

/**
 * In-process pub/sub for run events. One registry per daemon process.
 * Subscribers are keyed by runId so a stream can never observe another run's
 * events. Unsubscribe is idempotent and safe to call from a socket close handler.
 */
export class EventBus {
  private readonly listeners = new Map<string, Set<EventListener>>();

  subscribe(runId: string, listener: EventListener): () => void {
    const set = this.listeners.get(runId) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(runId, set);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.listeners.get(runId);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(runId);
    };
  }

  publish(event: RunEvent): void {
    const set = this.listeners.get(event.runId);
    if (set === undefined) return;
    for (const listener of set) {
      try {
        listener(event);
      } catch {
        // A broken listener must not stop delivery to the others.
      }
    }
  }

  count(runId: string): number {
    return this.listeners.get(runId)?.size ?? 0;
  }

  total(): number {
    let sum = 0;
    for (const set of this.listeners.values()) sum += set.size;
    return sum;
  }
}

/**
 * SSE event names must not collide with EventSource built-ins (`error`, `message`,
 * `open`). A domain event literally named `error` would otherwise be dispatched as a
 * transport failure, forcing clients into reconnect logic on every failed run.
 */
export function sseEventName(type: string): string {
  return type === 'error' ? 'run.error' : type;
}

export function writeSseEvent(
  write: (chunk: string) => void,
  event: { type: string; data: unknown },
): void {
  write(`event: ${sseEventName(event.type)}\n`);
  write(`data: ${JSON.stringify(event.data)}\n\n`);
}

export const SSE_HEARTBEAT_MS = 15_000;

export function writeHeartbeat(write: (chunk: string) => void): void {
  write(': ping\n\n');
}
