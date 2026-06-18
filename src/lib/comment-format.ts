import { createElement, type ReactNode } from 'react';
import type { Agent } from '../../server/types';

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/g;

/**
 * Display name for a comment author: "You" for the local user (no agent id),
 * otherwise the agent's label (falling back to "agent" if it's gone).
 */
export function authorLabel(c: { agent_id: string | null }, agents: Agent[]): string {
  if (c.agent_id == null) return 'You';
  return agents.find((a) => a.id === c.agent_id)?.label ?? 'agent';
}

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
