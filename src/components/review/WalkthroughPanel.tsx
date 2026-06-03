import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { cn } from '@/lib/utils';
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

function previewLines(text: string, maxLines: number): string {
  const lines = text.split(/\n/).filter(Boolean);
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n');
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
  const hasScalars = !!(g.type || g.risk || g.effort !== undefined || g.relevant_tests);
  const hasSecurity = g.security_concerns != null && g.security_concerns !== '';
  const hasContent =
    g.summary ||
    hasScalars ||
    hasSecurity ||
    keyPoints.length > 0 ||
    tickets.length > 0;

  if (!hasContent) return null;

  const summaryPreview = g.summary ? previewLines(g.summary, 2) : null;

  return (
    <section
      data-testid="walkthrough-panel"
      data-expanded={expanded ? 'true' : 'false'}
      className="border-b border-glass-edge bg-glass-l1"
    >
      <div className="flex items-start gap-2 px-4 py-2">
        <button
          type="button"
          onClick={toggle}
          className="focus-ring mt-0.5 shrink-0 rounded px-1 text-xs font-semibold text-foreground hover:bg-glass-l2/60"
          aria-expanded={expanded}
        >
          {expanded ? '▾' : '▸'} Walkthrough
        </button>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {g.type && (
              <Badge variant="outline" className="text-[10px]">
                {g.type}
              </Badge>
            )}
            {g.risk && (
              <Badge variant="outline" className="text-[10px]">
                risk: {g.risk}
              </Badge>
            )}
            {g.effort !== undefined && (
              <Badge variant="outline" className="text-[10px]">
                effort {g.effort}/5
              </Badge>
            )}
            {g.relevant_tests && (
              <Badge variant="outline" className="text-[10px]">
                tests: {g.relevant_tests}
              </Badge>
            )}
            {hasSecurity && (
              <Badge variant="destructive" className="text-[10px]">
                security: {g.security_concerns}
              </Badge>
            )}
            {!expanded && keyPoints.length > 0 && (
              <span className="text-[10px] text-muted-foreground">
                {keyPoints.length} focus {keyPoints.length === 1 ? 'area' : 'areas'}
              </span>
            )}
          </div>

          {!expanded && summaryPreview && (
            <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {summaryPreview}
            </p>
          )}
        </div>

        <Button
          variant="ghost"
          size="xs"
          className="shrink-0 text-xs text-muted-foreground"
          onClick={toggle}
        >
          {expanded ? 'Collapse' : 'Expand'}
        </Button>
      </div>

      {expanded && (
        <div
          data-testid="walkthrough-panel-body"
          className="space-y-3 border-t border-glass-edge/60 px-4 pb-3 pt-2"
        >
          {g.summary && (
            <p className="max-w-4xl text-sm leading-relaxed text-foreground">{g.summary}</p>
          )}

          {keyPoints.length > 0 && (
            <div data-testid="walkthrough-key-points">
              <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Where to focus
              </h3>
              <ul className="list-disc space-y-1 pl-5 text-sm text-foreground">
                {keyPoints.map((point) => (
                  <li key={point} className="leading-snug">
                    {point}
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
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t.detail}</p>
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

// Re-export types for consumers that imported from WalkthroughHeader
export type {
  Walkthrough,
  WalkthroughFile,
  WalkthroughGroup,
  WalkthroughGlobal,
} from './walkthrough-types';
