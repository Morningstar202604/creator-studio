import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type ToastTone = 'ok' | 'error' | 'info';

type Toast = { id: number; text: string; tone: ToastTone };

/**
 * Transient feedback. Success and neutral messages disappear on their own; errors
 * stay a little longer but still leave, because a stuck banner trains people to
 * ignore it. Anything the user must act on belongs inline, not here.
 */
export function useToasts(timeoutMs = 3200) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef<number[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (text: string, tone: ToastTone = 'ok') => {
      const id = nextId.current++;
      setToasts((current) => [...current, { id, text, tone }]);
      const handle = window.setTimeout(() => dismiss(id), tone === 'error' ? timeoutMs * 2 : timeoutMs);
      timers.current.push(handle);
    },
    [dismiss, timeoutMs],
  );

  useEffect(
    () => () => {
      for (const handle of timers.current) window.clearTimeout(handle);
      timers.current = [];
    },
    [],
  );

  return { toasts, push, dismiss };
}

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}): React.ReactElement | null {
  if (toasts.length === 0) return null;
  // Portal to body: an ancestor with `overflow: hidden` would clip a fixed child and
  // shift it relative to that ancestor's box.
  return createPortal(
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.tone}`}>
          <span>{toast.text}</span>
          <button className="icon-btn" aria-label="关闭提示" onClick={() => onDismiss(toast.id)}>
            ✕
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
