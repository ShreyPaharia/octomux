/**
 * src/components/orchestrator/MessageThread.tsx
 *
 * Renders a run of orchestrator chat messages (user + assistant bubbles).
 *
 * Pure presentational, NON-scrolling, inline list. It is composed inside
 * MixedThread (OrchestratorPage), which owns the single scroll container and
 * the scroll-to-bottom behaviour. MessageThread must NOT introduce its own
 * `overflow`/`flex-1`/scroll: when tool-call cards interleave and split the
 * thread into several MessageThread batches, a per-batch scroll container would
 * create multiple nested scroll regions that overlap and "stick" (SHR-161 bug).
 */

import { cn } from '@/lib/utils';
import { Markdown } from './Markdown';

export interface ThreadMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

interface MessageThreadProps {
  messages: ThreadMessage[];
  /** Optional additional class name for the container. */
  className?: string;
}

export function MessageThread({ messages, className }: MessageThreadProps) {
  if (messages.length === 0) return null;

  return (
    <div className={cn('flex flex-col gap-3 px-4 py-2', className)}>
      {messages.map((msg) => (
        <div
          key={msg.id}
          data-role={msg.role}
          className={cn(
            'flex max-w-[85%] flex-col rounded-xl px-4 py-2.5 text-sm',
            msg.role === 'user'
              ? 'ml-auto bg-[#3B82F6] text-white'
              : 'mr-auto bg-[rgba(255,255,255,0.06)] text-foreground',
          )}
        >
          {msg.role === 'assistant' ? (
            // Assistant output renders as sanitized markdown (SHR-161).
            <Markdown>{msg.text}</Markdown>
          ) : (
            // User text stays verbatim — don't reinterpret their input as markdown.
            <span className="whitespace-pre-wrap leading-relaxed">{msg.text}</span>
          )}
        </div>
      ))}
    </div>
  );
}
