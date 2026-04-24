import { lazy, Suspense, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { GlassPanel } from '@/components/ui/glass-panel';
import { StatusGlyph } from '@/components/ui/status-glyph';
import { api } from '@/lib/api';
import { useOrchestratorContext } from '@/lib/orchestrator-context';
import { showToast } from '@/components/CustomToast';
import type { Agent } from '../../server/types';

const TerminalView = lazy(() =>
  import('@/components/TerminalView').then((m) => ({ default: m.TerminalView })),
);

const ORCHESTRATOR_ID = 'orchestrator';

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

  if (id === ORCHESTRATOR_ID) {
    return <OrchestratorChat />;
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

function Keycap({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="inline-flex h-5 items-center gap-0.5 border border-glass-edge bg-glass-l1 px-1.5 font-mono text-[10px] text-[#b5b5bd]"
      style={{ boxShadow: 'inset 0 1px 0 0 rgba(255,255,255,0.12)' }}
    >
      {children}
    </span>
  );
}

interface OrchestratorRoutine {
  cadence: string;
  lastFired: string;
}

function OrchestratorChat({ routine }: { routine?: OrchestratorRoutine | null } = {}) {
  const { running, loading, restart } = useOrchestratorContext();
  const [showHelp, setShowHelp] = useState(false);

  return (
    <div className="flex h-full flex-col bg-background">
      <OrchestratorHeader
        running={running}
        restart={restart}
        routine={routine ?? null}
        showHelp={showHelp}
        onToggleHelp={() => setShowHelp((v) => !v)}
      />

      <div
        className="min-h-0 flex-1"
        style={{ backgroundColor: 'var(--color-terminal-bg)' }}
        data-testid="orchestrator-terminal-pane"
      >
        {loading ? (
          <div className="flex h-full items-center justify-center text-[#6a6a6a]">Loading...</div>
        ) : !running ? (
          <div className="flex h-full items-center justify-center text-[#6a6a6a]">
            Starting orchestrator...
          </div>
        ) : (
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-[#6a6a6a]">
                Loading terminal...
              </div>
            }
          >
            <TerminalView wsUrl="/ws/terminal/orchestrator" visible />
          </Suspense>
        )}
      </div>

      {running && <OrchestratorPrompt />}
    </div>
  );
}

function OrchestratorHeader({
  running,
  restart,
  routine,
  showHelp,
  onToggleHelp,
}: {
  running: boolean;
  restart: () => Promise<void> | void;
  routine: OrchestratorRoutine | null;
  showHelp: boolean;
  onToggleHelp: () => void;
}) {
  return (
    <GlassPanel level={1} className="relative">
      <div className="flex items-center gap-3 px-6 py-3">
        <span className="text-[10px] font-bold uppercase tracking-wider text-[#6a6a6a]">
          // ORCHESTRATOR
        </span>
        <StatusGlyph status={running ? 'running' : 'closed'} size={10} />
        {running && (
          <span
            data-testid="orchestrator-running-pill"
            className="inline-flex items-center gap-1 border border-[#22C55E]/40 bg-[#22C55E]/10 px-2 py-0.5 font-mono text-[10px] font-bold tracking-wider text-[#22C55E]"
          >
            ● RUNNING
          </span>
        )}
        <div className="relative">
          <button
            type="button"
            onClick={onToggleHelp}
            aria-label="Orchestrator help"
            aria-expanded={showHelp}
            data-testid="orchestrator-help-chip"
            className="focus-ring flex h-5 w-5 items-center justify-center border border-glass-edge bg-glass-l1 text-[10px] text-[#b5b5bd] hover:text-white"
          >
            ?
          </button>
          {showHelp && <OrchestratorHelpCard />}
        </div>
        {routine && (
          <span className="font-mono text-[10px] text-[#8a8a8a]">
            every {routine.cadence} · last fired {routine.lastFired}
          </span>
        )}
        <div className="ml-auto flex items-center gap-3">
          {running && (
            <button
              type="button"
              onClick={() => void restart()}
              className="focus-ring font-mono text-[10px] font-bold uppercase tracking-wider text-[#8a8a8a] hover:text-white"
            >
              RESTART
            </button>
          )}
          <Keycap>⌘K</Keycap>
        </div>
      </div>
    </GlassPanel>
  );
}

function OrchestratorHelpCard() {
  return (
    <GlassPanel
      level={3}
      specular
      role="dialog"
      aria-label="Orchestrator help"
      data-testid="orchestrator-help-card"
      className="absolute left-0 top-7 z-50 w-80 p-4 text-xs"
    >
      <p className="mb-2 font-bold text-white">What can the orchestrator do?</p>
      <ul className="mb-3 space-y-1 text-[#b5b5bd]">
        <li>Create tasks to dispatch autonomous Claude Code agents</li>
        <li>Monitor running tasks and their agents</li>
        <li>Close or resume tasks as needed</li>
        <li>Add agents to running tasks for parallel work</li>
        <li>Generate PR previews and create PRs for completed work</li>
      </ul>
      <p className="mb-1 font-bold text-white">Try something like:</p>
      <ul className="space-y-1 text-[#b5b5bd]">
        <li>&ldquo;Create a task to fix the login bug&rdquo;</li>
        <li>&ldquo;Show me all running tasks&rdquo;</li>
        <li>&ldquo;What is the status of task abc123?&rdquo;</li>
      </ul>
    </GlassPanel>
  );
}

function OrchestratorPrompt() {
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);

  const submit = async () => {
    const message = value.trim();
    if (!message || sending) return;
    setSending(true);
    try {
      await api.orchestratorSend(message);
      setValue('');
    } catch (err) {
      showToast('error', 'ERROR', err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setSending(false);
    }
  };

  return (
    <GlassPanel level={1} className="border-t border-glass-edge">
      <form
        className="flex items-center gap-3 px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <SparklesIcon />
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="Ask the orchestrator to schedule, check, or dispatch…"
          aria-label="Orchestrator prompt"
          data-testid="orchestrator-prompt-input"
          disabled={sending}
          className="focus-ring flex-1 bg-transparent text-sm text-white placeholder:text-[#6a6a6a] outline-none disabled:opacity-50"
        />
        <Keycap>⌘↵</Keycap>
      </form>
    </GlassPanel>
  );
}

function SparklesIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-[#60a5fa]"
      aria-hidden="true"
    >
      <path d="M12 3v4" />
      <path d="M12 17v4" />
      <path d="M3 12h4" />
      <path d="M17 12h4" />
      <path d="m6 6 2.5 2.5" />
      <path d="m15.5 15.5 2.5 2.5" />
      <path d="m6 18 2.5-2.5" />
      <path d="m15.5 8.5 2.5-2.5" />
    </svg>
  );
}
