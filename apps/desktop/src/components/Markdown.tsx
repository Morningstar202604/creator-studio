import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

/**
 * Renders agent-authored Markdown. Everything is sanitized: model output and
 * research quotes are untrusted input, so raw HTML must never reach the DOM.
 */
export function Markdown({ content, className }: { content: string; className?: string }): React.ReactElement {
  const html = useMemo(() => {
    const raw = marked.parse(content, { async: false }) as string;
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  }, [content]);

  return (
    <div
      className={`md${className === undefined ? '' : ` ${className}`}`}
      // Sanitized above; no script/event handlers survive DOMPurify.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
