import { useMemo } from 'react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { cn } from '@/lib/utils';
import { riskBadgeClass } from '@/lib/review-display';
import {
  normalizeTicketCompliance,
  ticketToneClass,
  ticketToneIcon,
} from '@/lib/walkthrough-tickets';
import type { RenderGroup } from '@/lib/review-file-groups';
import type { Walkthrough, WalkthroughHighlight } from './walkthrough-types';

interface WalkthroughOrientProps {
  walkthrough: Walkthrough;
  groups: RenderGroup[];
  blockingCount: number;
  findingCount: number;
  onStartReview: () => void;
  onSelectHighlight: (h: WalkthroughHighlight) => void;
  onSelectGroup: (group: RenderGroup) => void;
}

function shortPath(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

/**
 * ORIENT state: one calm, readable surface answering "what is this PR and what
 * should I look at". The pyramid — verdict → ≤5 code-linked highlights → context →
 * groups — with a single primary action into REVIEW.
 */
export function WalkthroughOrient({
  walkthrough,
  groups,
  blockingCount,
  findingCount,
  onStartReview,
  onSelectHighlight,
  onSelectGroup,
}: WalkthroughOrientProps) {
  const g = walkthrough.global ?? {};

  // Verdict headline, with a graceful fallback for pre-pyramid runs.
  const verdict = walkthrough.verdict?.trim() || g.summary?.trim() || 'Review ready.';

  // Highlights, with a fallback that lifts legacy key_review_points (unlinked).
  const highlights: WalkthroughHighlight[] = useMemo(() => {
    if (walkthrough.highlights?.length) return walkthrough.highlights.slice(0, 5);
    return (g.key_review_points ?? [])
      .filter(Boolean)
      .slice(0, 5)
      .map((title) => ({ title, file: '' }));
  }, [walkthrough.highlights, g.key_review_points]);

  const tickets = useMemo(
    () => (g.ticket_compliance ?? []).map(normalizeTicketCompliance),
    [g.ticket_compliance],
  );

  const hasSecurity = g.security_concerns != null && g.security_concerns !== '';
  const hasContextParagraph = !!g.summary && g.summary.trim() !== verdict;

  return (
    <section
      data-testid="walkthrough-orient"
      className="min-h-0 flex-1 overflow-y-auto"
      aria-label="Pull request walkthrough"
    >
      <div className="mx-auto w-full max-w-3xl space-y-7 px-5 py-8 sm:px-8">
        {/* Verdict */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {g.type && (
              <Badge variant="outline" className="text-[10px]">
                {g.type}
              </Badge>
            )}
            {g.risk && (
              <Badge variant="outline" className={cn('text-[10px]', riskBadgeClass(g.risk))}>
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
          </div>
          <p
            data-testid="walkthrough-verdict"
            className="text-pretty text-lg font-medium leading-snug text-foreground sm:text-xl"
          >
            {verdict}
          </p>
          {hasContextParagraph && (
            <p className="text-pretty text-sm leading-relaxed text-muted-foreground">{g.summary}</p>
          )}
          {hasSecurity && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive">
              {g.security_concerns}
            </p>
          )}
        </div>

        {/* Highlights — the ≤5 things that actually matter */}
        {highlights.length > 0 && (
          <div className="space-y-2" data-testid="walkthrough-highlights">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Look at these
            </h2>
            <ol className="space-y-1.5">
              {highlights.map((h, i) => {
                const linked = !!h.file;
                return (
                  <li key={`${h.title}-${i}`}>
                    <button
                      type="button"
                      data-testid={`walkthrough-highlight-${i}`}
                      disabled={!linked}
                      onClick={() => linked && onSelectHighlight(h)}
                      className={cn(
                        'group flex w-full items-start gap-3 rounded-lg border border-glass-edge bg-glass-l1/60 px-3 py-2.5 text-left transition-colors',
                        linked ? 'hover:border-primary/40 hover:bg-glass-l2/50' : 'cursor-default',
                      )}
                    >
                      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 font-mono text-[11px] font-semibold text-primary">
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm leading-snug text-foreground">
                          {h.title}
                        </span>
                        {h.detail && (
                          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                            {h.detail}
                          </span>
                        )}
                        {linked && (
                          <span className="mt-1 inline-flex items-center gap-1 font-mono text-[10px] text-blue-300">
                            {shortPath(h.file)}
                            {h.line ? `:${h.line}` : ''}
                            <span className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                              → open
                            </span>
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        )}

        {/* Tickets */}
        {tickets.length > 0 && (
          <div className="space-y-2" data-testid="walkthrough-tickets">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Tickets
            </h2>
            <ul className="space-y-1.5">
              {tickets.map((t) => (
                <li
                  key={t.ticket}
                  className="rounded-lg border border-glass-edge bg-glass-l1/60 px-3 py-2 text-xs"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono font-medium text-foreground">{t.ticket}</span>
                    <span className={cn('font-medium', ticketToneClass(t.tone))}>
                      {t.label} {ticketToneIcon(t.tone)}
                    </span>
                  </div>
                  {t.detail && (
                    <p className="mt-1 leading-relaxed text-muted-foreground">{t.detail}</p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Groups — the map, one line each; detail surfaces later in review */}
        {groups.length > 0 && (
          <div className="space-y-2" data-testid="walkthrough-groups">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Changed areas
            </h2>
            <ul className="divide-y divide-glass-edge/60 overflow-hidden rounded-lg border border-glass-edge">
              {groups.map((group) => (
                <li key={group.name}>
                  <button
                    type="button"
                    data-testid={`walkthrough-group-${group.name}`}
                    onClick={() => onSelectGroup(group)}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left text-xs hover:bg-glass-l2/40"
                  >
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                      {group.name}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {group.files.length} {group.files.length === 1 ? 'file' : 'files'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Primary action into review */}
        <div className="flex flex-wrap items-center gap-3 border-t border-glass-edge/60 pt-5">
          <Button size="sm" data-testid="start-review-btn" onClick={onStartReview}>
            Start review →
          </Button>
          <span className="text-xs text-muted-foreground">
            {findingCount === 0
              ? 'No AI findings to triage'
              : `${findingCount} finding${findingCount === 1 ? '' : 's'} to triage${
                  blockingCount > 0 ? ` · ${blockingCount} blocking` : ''
                }`}
          </span>
        </div>
      </div>
    </section>
  );
}
