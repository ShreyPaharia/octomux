import { createElement, type ReactNode } from 'react';

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/g;

/**
 * Render plain-text comment bodies with bare http/https URLs turned into anchors.
 * Returns an array of strings + anchor elements suitable for use as React children.
 */
export function linkify(text: string): ReactNode[] {
  if (!text) return [text];
  const out: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((match = URL_RE.exec(text)) !== null) {
    const start = match.index;
    const url = match[0];
    if (start > lastIndex) out.push(text.slice(lastIndex, start));
    out.push(
      createElement(
        'a',
        {
          key: `${start}-${url}`,
          href: url,
          target: '_blank',
          rel: 'noopener noreferrer',
          className: 'text-[#3B82F6] underline',
        },
        url,
      ),
    );
    lastIndex = start + url.length;
  }
  if (lastIndex < text.length) out.push(text.slice(lastIndex));
  return out;
}
