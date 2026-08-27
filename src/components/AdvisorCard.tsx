/**
 * src/components/AdvisorCard.tsx
 *
 * Home-page entry point for the Advisor — a conductor chat mode that helps the
 * user set up schedules, loops, agents, and settings. Collapsed: a prompt box
 * plus starter questions. On submit it ensures the advisor session via
 * `POST /api/advisor/session` and embeds the existing <AgentSessionChat>
 * inline, sending the question as the first turn.
 */

import { useCallback, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { agentsApi, type AgentSession } from '@/lib/api/agentsApi';
import { AgentSessionChat } from '@/components/AgentSessionChat';

const STARTER_QUESTIONS = [
  'What schedules would help this repo?',
  'Review my setup',
  'Automate my code reviews',
];

export function AdvisorCard() {
  const [input, setInput] = useState('');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<AgentSession | null>(null);
  const [firstMessage, setFirstMessage] = useState<string | undefined>(undefined);

  const start = useCallback(
    async (question: string) => {
      if (starting) return;
      setStarting(true);
      setError(null);
      try {
        const s = await agentsApi.advisorSession();
        setFirstMessage(question.trim() || undefined);
        setSession(s);
      } catch (err) {
        setError((err as Error).message || 'Failed to start the advisor');
      } finally {
        setStarting(false);
      }
    },
    [starting],
  );

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      void start(input);
    },
    [start, input],
  );

  if (session) {
    return (
      <div
        data-testid="advisor-card"
        className="bg-glass-l2 glass-blur-l2 flex h-[440px] flex-col overflow-hidden rounded-2xl border border-glass-edge"
      >
        <div className="flex items-center justify-between border-b border-glass-edge px-4 py-2">
          <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <span aria-hidden className="text-primary">
              ✦
            </span>
            Advisor
          </span>
          {session.agent_id && (
            <Link
              to={`/agents/${session.agent_id}`}
              data-testid="advisor-open-full"
              className="text-[11px] text-muted-soft hover:text-foreground"
            >
              Open full view →
            </Link>
          )}
        </div>
        <div className="min-h-0 flex-1">
          <AgentSessionChat convId={session.id} initialMessage={firstMessage} />
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="advisor-card"
      className="bg-glass-l2 glass-blur-l2 flex flex-col gap-3 rounded-2xl border border-glass-edge p-4 sm:p-5"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className="text-primary">
          ✦
        </span>
        <h2 className="text-sm font-semibold text-foreground">Improve your workflow</h2>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Chat with the advisor — it reads your schedules, tasks, and settings, then recommends (and
        can create) schedules, loops, and agents.
      </p>
      <div className="flex flex-wrap gap-2">
        {STARTER_QUESTIONS.map((q) => (
          <button
            key={q}
            type="button"
            data-testid="advisor-starter"
            disabled={starting}
            onClick={() => void start(q)}
            className="rounded-full border border-glass-edge bg-glass-l1 px-3 py-1.5 text-xs text-foreground transition-colors hover:border-primary/40 hover:text-primary disabled:opacity-50"
          >
            {q}
          </button>
        ))}
      </div>
      <form onSubmit={handleSubmit} className="flex items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask the advisor anything about your octomux setup…"
          aria-label="Advisor question"
          data-testid="advisor-input"
          className="flex-1 rounded-xl border border-glass-edge bg-glass-l1 px-3.5 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <button
          type="submit"
          disabled={starting || !input.trim()}
          data-testid="advisor-submit"
          className="rounded-xl bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {starting ? 'Starting…' : 'Ask'}
        </button>
      </form>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
