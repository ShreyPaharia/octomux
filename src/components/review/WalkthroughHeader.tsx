import { useState, useEffect } from 'react';
import { ChevronDownIcon } from '../icons';

interface TicketCompliance {
  ticket: string;
  status: 'compliant' | 'partially' | 'non-compliant';
}

export interface WalkthroughFile {
  path: string;
  label?: string;
  summary?: string;
}

export interface WalkthroughGroup {
  name: string;
  summary?: string;
  files?: WalkthroughFile[];
}

interface WalkthroughGlobal {
  type?: string;
  risk?: string;
  effort?: number;
  relevant_tests?: string;
  security_concerns?: string | null;
  ticket_compliance?: TicketCompliance[];
  summary?: string;
  key_review_points?: string[];
}

export interface Walkthrough {
  global?: WalkthroughGlobal;
  groups?: WalkthroughGroup[];
}

interface WalkthroughHeaderProps {
  walkthrough: Walkthrough;
  taskId: string;
}

const COLLAPSE_KEY = (taskId: string) => `octomux:walkthrough-collapsed:${taskId}`;

function riskTone(risk?: string): 'neutral' | 'warn' | 'danger' {
  if (risk === 'high' || risk === 'critical') return 'danger';
  if (risk === 'medium' || risk === 'med') return 'warn';
  return 'neutral';
}

function ScalarPill({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'warn' | 'danger';
}) {
  const toneClasses = {
    neutral: 'border-glass-edge bg-glass-l1 text-muted-foreground',
    warn: 'border-amber-400/40 bg-amber-400/10 text-amber-300',
    danger: 'border-red-400/40 bg-red-400/10 text-red-300',
  }[tone];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${toneClasses}`}
    >
      {children}
    </span>
  );
}

export function WalkthroughHeader({ walkthrough, taskId }: WalkthroughHeaderProps) {
  const g = walkthrough.global ?? {};
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    try {
      const v = localStorage.getItem(COLLAPSE_KEY(taskId));
      if (v !== null) setCollapsed(v === 'true');
    } catch {
      // localStorage unavailable
    }
  }, [taskId]);

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSE_KEY(taskId), String(next));
      } catch {
        // localStorage unavailable
      }
      return next;
    });
  }

  const hasContent =
    g.type ||
    g.risk ||
    g.effort !== undefined ||
    g.relevant_tests ||
    g.security_concerns ||
    g.summary ||
    (g.key_review_points && g.key_review_points.length > 0) ||
    (g.ticket_compliance && g.ticket_compliance.length > 0);
  if (!hasContent) return null;

  return (
    <section data-testid="walkthrough-header" className="border-b border-glass-edge bg-glass-l1">
      <header className="flex items-center justify-between gap-2 px-4 py-2">
        <button
          type="button"
          onClick={toggle}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
          aria-expanded={!collapsed}
          aria-controls="walkthrough-header-body"
        >
          <ChevronDownIcon
            aria-hidden
            className={collapsed ? '-rotate-90 transition-transform' : 'transition-transform'}
          />
          <span className="shrink-0">Walkthrough</span>
          {collapsed && g.summary && (
            <span className="ml-2 min-w-0 truncate text-xs font-normal text-muted-foreground/80">
              — {g.summary.split(/[.!?](\s|$)/)[0]}
            </span>
          )}
        </button>
        {!collapsed && (g.type || g.risk || g.effort !== undefined || g.relevant_tests) && (
          <div className="flex flex-wrap gap-2">
            {g.type && <ScalarPill>{g.type}</ScalarPill>}
            {g.risk && <ScalarPill tone={riskTone(g.risk)}>Risk: {g.risk}</ScalarPill>}
            {g.effort !== undefined && <ScalarPill>Effort {g.effort}/5</ScalarPill>}
            {g.relevant_tests && <ScalarPill>Tests: {g.relevant_tests}</ScalarPill>}
            {g.security_concerns && (
              <ScalarPill tone="danger">Security: {g.security_concerns}</ScalarPill>
            )}
          </div>
        )}
      </header>

      {!collapsed && (
        <div id="walkthrough-header-body" className="max-h-60 space-y-3 overflow-y-auto px-4 pb-3">
          {g.ticket_compliance && g.ticket_compliance.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {g.ticket_compliance.map((tc) => (
                <ScalarPill key={tc.ticket}>
                  {tc.ticket}{' '}
                  <span
                    className={
                      tc.status === 'compliant'
                        ? 'text-green-400'
                        : tc.status === 'partially'
                          ? 'text-yellow-400'
                          : 'text-red-400'
                    }
                  >
                    {tc.status}
                  </span>
                </ScalarPill>
              ))}
            </div>
          )}

          {g.summary && (
            <div>
              <p className="text-sm text-foreground">{g.summary}</p>
            </div>
          )}

          {g.key_review_points && g.key_review_points.length > 0 && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Key points
              </p>
              <ul className="space-y-1">
                {g.key_review_points.map((pt, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <span className="mt-1 shrink-0 text-muted-foreground">·</span>
                    <span>{pt}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
