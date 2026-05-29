import type { ReactNode } from 'react';

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
}

function firstSentence(text: string): string {
  const m = text.match(/^(.+?[.!?])(\s|$)/);
  return m ? m[1] : text;
}

function Pip({ children }: { children: ReactNode }) {
  return <span className="shrink-0 text-[11px] opacity-70">· {children}</span>;
}

export function WalkthroughHeader({ walkthrough }: WalkthroughHeaderProps) {
  const g = walkthrough.global ?? {};
  const meta: string[] = [];
  if (g.risk) meta.push(`risk: ${g.risk}`);
  if (g.effort !== undefined) meta.push(`effort ${g.effort}/5`);
  if (g.relevant_tests) meta.push(`tests: ${g.relevant_tests}`);
  if (g.security_concerns) meta.push(`security: ${g.security_concerns}`);
  if (g.key_review_points && g.key_review_points.length > 0) {
    meta.push(`${g.key_review_points.length} key points`);
  }
  if (g.ticket_compliance && g.ticket_compliance.length > 0) {
    for (const tc of g.ticket_compliance) {
      meta.push(
        `${tc.ticket} ${tc.status === 'compliant' ? '✓' : tc.status === 'partially' ? '~' : '✗'}`,
      );
    }
  }

  const hasContent = g.summary || meta.length > 0 || g.type;
  if (!hasContent) return null;

  return (
    <section
      data-testid="walkthrough-header"
      className="border-b border-glass-edge bg-glass-l1 px-4 py-1.5"
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="shrink-0 font-medium">Walkthrough</span>
        {g.summary && (
          <span className="min-w-0 flex-1 truncate" title={g.summary}>
            · {firstSentence(g.summary)}
          </span>
        )}
        {meta.length > 0 && (
          <Pip>{meta.join(' · ')}</Pip>
        )}
      </div>
    </section>
  );
}
