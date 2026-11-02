import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Right-hand drawer used for editing. It is a real `role="dialog"` with
 * `aria-modal`, traps Tab inside the panel, closes on Escape and restores focus to
 * whatever opened it — the three things that make an overlay usable without a mouse.
 *
 * The close handler is held in a ref on purpose: the focus/restore effect must run
 * only when `open` flips. Depending on an inline `onClose` made the effect re-run on
 * every keystroke, and its cleanup yanked focus back to the opener mid-typing.
 */
export function Drawer({
  open,
  title,
  onClose,
  children,
  footer,
  width = 520,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}): React.ReactElement | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const focusable = useCallback((): HTMLElement[] => {
    const panel = panelRef.current;
    if (panel === null) return [];
    // No visibility filter here: jsdom reports offsetParent === null for everything,
    // and a hidden-but-focusable node inside an open drawer is not a real failure mode.
    return Array.from(
      panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    restoreTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Focus the first real field rather than the close button, so typing can start
    // immediately; the close button stays reachable by Shift+Tab.
    //
    // This runs synchronously: a delayed focus steals the caret from a user (or a
    // test) that already clicked another field in the first frame, which showed up
    // as characters landing in the title instead of the name field.
    const current = document.activeElement;
    if (current === null || current === document.body || !panelRef.current?.contains(current)) {
      const fields = focusable().filter((node) => node.tagName !== 'BUTTON');
      (fields[0] ?? focusable()[0])?.focus();
    }

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = focusable();
      if (nodes.length === 0) return;
      const first = nodes[0] as HTMLElement;
      const last = nodes[nodes.length - 1] as HTMLElement;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panelRef.current?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      restoreTo.current?.focus();
    };
  }, [open, focusable]);

  if (!open) return null;

  return createPortal(
    <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="drawer" role="dialog" aria-modal="true" aria-label={title} ref={panelRef} style={{ width }}>
        <div className="drawer-head">
          <h2>{title}</h2>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer !== undefined && <div className="drawer-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
