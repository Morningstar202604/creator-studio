import { useEffect, useRef, useState } from 'react';
import type { RunEvent } from '../api';

export type StreamState = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

export type UseRunStreamResult = {
  events: RunEvent[];
  state: StreamState;
};

const POLL_FALLBACK_MS = 2000;

/**
 * Subscribes to a run's SSE stream. Falls back to polling when EventSource is
 * unavailable or errors, so the UI degrades instead of going blank.
 */
export function useRunStream(
  runId: string | null,
  url: string,
  fetcher: (after: number) => Promise<RunEvent[]>,
): UseRunStreamResult {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [state, setState] = useState<StreamState>('idle');
  const lastSeq = useRef(-1);
  const closed = useRef(false);

  useEffect(() => {
    closed.current = false;
    setEvents([]);
    lastSeq.current = -1;
    if (runId === null) {
      setState('idle');
      return undefined;
    }

    if (typeof EventSource === 'undefined') {
      setState('error');
      return undefined;
    }

    setState('connecting');
    // Absolute URL: inside the Tauri webview the page origin is http://tauri.localhost,
    // so a relative path would resolve against the asset host, not the daemon.
    const source = new EventSource(url);
    source.onopen = () => setState('open');
    source.onerror = () => {
      setState('error');
      source.close();
    };
    source.onmessage = () => {};

    const handler = (raw: MessageEvent<string>): void => {
      try {
        const parsed = JSON.parse(raw.data) as RunEvent;
        if (parsed.seq <= lastSeq.current) return;
        lastSeq.current = parsed.seq;
        setEvents((previous) => [...previous, parsed]);
      } catch {
        // Ignore malformed frames; the next event will still arrive.
      }
    };

    // `error` is renamed on the wire (see daemon sseEventName) because it collides
    // with EventSource's built-in transport error event.
    const types = [
      'step.started',
      'step.finished',
      'tool.called',
      'tool.result',
      'approval.requested',
      'budget.warning',
      'run.finished',
      'run.error',
    ];
    for (const type of types) source.addEventListener(type, handler as EventListener);

    return () => {
      closed.current = true;
      source.close();
    };
  }, [runId, url]);

  useEffect(() => {
    if (state !== 'error' || runId === null) return undefined;
    const timer = window.setInterval(() => {
      void fetcher(lastSeq.current).then((incoming) => {
        for (const event of incoming) {
          if (event.seq <= lastSeq.current) continue;
          lastSeq.current = event.seq;
          setEvents((previous) => [...previous, event]);
        }
      });
    }, POLL_FALLBACK_MS);
    return () => window.clearInterval(timer);
  }, [state, runId, fetcher]);

  return { events, state };
}
