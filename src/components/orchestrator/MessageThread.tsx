/**
 * src/components/orchestrator/MessageThread.tsx
 *
 * Renders a streamed orchestrator chat message thread.
 * Displays user and assistant messages with distinct visual styles.
 * Pure presentational component — all state is managed by OrchestratorPage.
 */

import { useEffect, useRef } from 'react';
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
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  if (messages.length === 0) {
    return (
      <div
        className={cn(
          'flex flex-1 items-center justify-center text-sm text-muted-foreground',
          className,
        )}
        aria-live="polite"
        aria-label="Message thread"
      >
        No messages yet. Start a conversation below.
      </div>
    );
  }

  return (
    <div
      className={cn('flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4', className)}
      role="log"
      aria-label="Message thread"
      aria-live="polite"
    >
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
      <div ref={bottomRef} aria-hidden="true" />
    </div>
  );
}
