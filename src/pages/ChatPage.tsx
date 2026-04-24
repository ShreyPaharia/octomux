import { lazy, Suspense, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Agent } from '../../server/types';

const TerminalView = lazy(() =>
  import('@/components/TerminalView').then((m) => ({ default: m.TerminalView })),
);

/**
 * Minimal viewer for a standalone runtime agent ("chat").
 * Attaches to the chat's tmux session via /ws/terminal/chat/:id.
 */
export default function ChatPage() {
  const { id } = useParams<{ id: string }>();
  const [chat, setChat] = useState<Agent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    fetch(`/api/chats/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((data: Agent) => {
        if (!cancelled) setChat(data);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-[#6a6a6a]">
        Chat not found ({error})
      </div>
    );
  }

  if (!chat) {
    return <div className="flex h-full items-center justify-center text-[#6a6a6a]">Loading...</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-border px-6 py-3">
        <span className="text-[10px] font-bold uppercase tracking-wider text-[#6a6a6a]">
          // CHAT
        </span>
        {chat.pinned && <span className="text-[10px] text-[#6a6a6a]">📌</span>}
        <span className="text-sm font-medium text-white">{chat.label}</span>
        {chat.status === 'running' && <span className="h-2 w-2 animate-pulse bg-[#22C55E]" />}
      </div>
      <div className="min-h-0 flex-1">
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-[#6a6a6a]">
              Loading terminal...
            </div>
          }
        >
          <TerminalView wsUrl={`/ws/terminal/chat/${chat.id}`} visible />
        </Suspense>
      </div>
    </div>
  );
}
