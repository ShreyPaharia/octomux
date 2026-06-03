import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '../ui/badge';
import { cn } from '@/lib/utils';
import { riskBadgeClass } from '@/lib/review-display';
import { ChevronDownIcon } from '../icons';
import {
  normalizeTicketCompliance,
  ticketToneClass,
  ticketToneIcon,
} from '@/lib/walkthrough-tickets';
import type { Walkthrough } from './walkthrough-types';

const STORAGE_KEY = 'octomux:review:walkthrough-expanded';

function readExpandedPreference(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored !== null) return stored === 'true';
  } catch {
    // ignore
  }
  return true;
}

interface WalkthroughPanelProps {
  walkthrough: Walkthrough;
}

export function WalkthroughPanel({ walkthrough }: WalkthroughPanelProps) {
  const g = walkthrough.global ?? {};
  const [expanded, setExpanded] = useState(readExpandedPreference);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(expanded));
    } catch {
      // ignore
    }
  }, [expanded]);

  const toggle = useCallback(() => setExpanded((v) => !v), []);

  const tickets = useMemo(
    () => (g.ticket_compliance ?? []).map(normalizeTicketCompliance),
    [g.ticket_compliance],
  );

  const keyPoints = g.key_review_points?.filter(Boolean) ?? [];
  const hasSecurity = g.security_concerns != null && g.security_concerns !== '';
  const hasContent =
    g.summary ||
    g.type ||
    g.risk ||
    g.effort !== undefined ||
    g.relevant_tests ||
    hasSecurity ||
    keyPoints.length > 0 ||
    tickets.length > 0;

  if (!hasContent) return null;

  const riskClass = riskBadgeClass(g.risk);

  return (
    <section
      data-testid="walkthrough-panel"
      data-expanded={expanded ? 'true' : 'false'}
      className="border-b border-glass-edge bg-glass-l1"
    >
      <button
        type="button"
        onClick={toggle}
        className="focus-ring flex w-full items-start gap-2 px-4 py-2.5 text-left hover:bg-glass-l2/30"
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse walkthrough' : 'Expand walkthrough'}
      >
        <ChevronDownIcon
          aria-hidden
          className={cn(
            'mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform',
            !expanded && '-rotate-90',
          )}
        />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold text-foreground">Walkthrough</span>
            {g.type && (
              <Badge variant="outline" className="text-[10px]">
                {g.type}
              </Badge>
            )}
            {g.risk && (
              <Badge variant="outline" className={cn('text-[10px]', riskClass)}>
                risk: {g.risk}
              </Badge>
            )}
            {g.effort !== undefined && (
              <Badge variant="outline" className="text-[10px]">
                effort {g.effort}/5
              </Badge>
            )}
            {g.relevant_tests && (
              <Badge
                variant="outline"
                className={cn(
                  'text-[10px]',
                  g.relevant_tests === 'no' && 'border-amber-500/40 text-amber-400',
                )}
              >
                tests: {g.relevant_tests}
              </Badge>
            )}
            {hasSecurity && (
              <Badge variant="destructive" className="text-[10px]">
                security
              </Badge>
            )}
            {!expanded && keyPoints.length > 0 && (
              <span className="text-[10px] text-muted-foreground">
                · {keyPoints.length} focus {keyPoints.length === 1 ? 'area' : 'areas'}
              </span>
            )}
          </div>
          {!expanded && g.summary && (
            <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {g.summary}
            </p>
          )}
        </div>
        <span className="shrink-0 pt-0.5 text-[10px] text-muted-foreground">
          {expanded ? 'Collapse' : 'Expand'}
        </span>
      </button>

      {expanded && (
        <div
          data-testid="walkthrough-panel-body"
          className="max-h-[min(280px,40vh)] space-y-3 overflow-y-auto border-t border-glass-edge/60 px-4 pb-3 pt-2"
        >
          {g.summary && (
            <p className="max-w-4xl text-sm leading-relaxed text-foreground">{g.summary}</p>
          )}

          {hasSecurity && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {g.security_concerns}
            </p>
          )}

          {keyPoints.length > 0 && (
            <div data-testid="walkthrough-key-points">
              <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Where to focus
              </h3>
              <ul className="space-y-1.5 text-sm text-foreground">
                {keyPoints.map((point) => (
                  <li key={point} className="flex gap-2 leading-snug">
                    <span className="mt-1.5 size-1 shrink-0 rounded-full bg-primary" aria-hidden />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {tickets.length > 0 && (
            <div data-testid="walkthrough-tickets">
              <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Tickets
              </h3>
              <ul className="space-y-2">
                {tickets.map((t) => (
                  <li
                    key={t.ticket}
                    className="rounded-lg border border-glass-edge bg-glass-l2/40 px-3 py-2"
                  >
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-mono font-medium text-foreground">{t.ticket}</span>
                      <span className={cn('font-medium', ticketToneClass(t.tone))}>
                        {t.label} {ticketToneIcon(t.tone)}
                      </span>
                    </div>
                    {t.detail && (
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        {t.detail}
                      </p>
                    )}
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

export type {
  Walkthrough,
  WalkthroughFile,
  WalkthroughGroup,
  WalkthroughGlobal,
} from './walkthrough-types';
