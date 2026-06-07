import { lazy, Suspense, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Agent } from '../../server/types';

const TerminalView = lazy(() =>
  import('@/components/TerminalView').then((m) => ({ default: m.TerminalView })),
);

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
    <div className="octomux-agent-session flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2 md:gap-3 md:px-6 md:py-3">
        <span className="text-[10px] font-bold uppercase tracking-wider text-[#6a6a6a]">
          // CHAT
        </span>
        <span className="text-sm font-medium text-white">{chat.label}</span>
        {chat.agent && (
          <span
            className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-mono"
            style={{
              backgroundColor: 'rgba(245, 158, 11, 0.12)',
              borderColor: 'rgba(245, 158, 11, 0.4)',
              color: '#F59E0B',
            }}
            title={`Running as agent: ${chat.agent}`}
          >
            🤖 {chat.agent}
          </span>
        )}
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
