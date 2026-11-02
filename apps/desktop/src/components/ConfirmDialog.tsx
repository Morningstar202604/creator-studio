import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

/**
 * Confirmation dialog for destructive actions. Rendered as a native `<dialog>` when
 * available so focus handling and Escape come from the platform; the fallback panel
 * keeps the same keyboard behaviour in jsdom.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '确认删除',
  cancelLabel = '取消',
  tone = 'danger',
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'normal';
  onConfirm: () => void;
  onCancel: () => void;
}): React.ReactElement | null {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    // Cancel is focused first: Enter then does the safe thing.
    const timer = window.setTimeout(() => cancelRef.current?.focus(), 20);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, onCancel]);

  if (!open) return null;

  return createPortal(
    <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <div className="confirm" role="alertdialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <p>{message}</p>
        <div className="row end">
          <button className="btn" ref={cancelRef} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className={tone === 'danger' ? 'btn danger' : 'btn primary'} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
