export type TicketComplianceTone = 'positive' | 'partial' | 'negative' | 'neutral';

export interface NormalizedTicketCompliance {
  ticket: string;
  label: string;
  tone: TicketComplianceTone;
  detail: string | null;
}

/** Map agent / legacy status strings to display label + tone. */
export function normalizeTicketCompliance(entry: {
  ticket: string;
  status: string;
  notes?: string;
  reason?: string;
}): NormalizedTicketCompliance {
  const raw = entry.status.toLowerCase().replace(/_/g, ' ').trim();
  const detail = (entry.notes ?? entry.reason)?.trim() || null;

  let tone: TicketComplianceTone = 'neutral';
  let label = entry.status;

  if (
    ['compliant', 'fully', 'full', 'satisfied', 'addressed', 'met', 'yes', 'complete', 'done'].some(
      (s) => raw === s || raw.startsWith(s),
    )
  ) {
    tone = 'positive';
    label = 'Met';
  } else if (['partially', 'partial', 'part'].some((s) => raw === s || raw.startsWith(s))) {
    tone = 'partial';
    label = 'Partial';
  } else if (
    ['non-compliant', 'non compliant', 'not', 'failed', 'missing', 'unmet', 'no'].some(
      (s) => raw === s || raw.startsWith(s),
    ) &&
    raw !== 'no ticket'
  ) {
    tone = 'negative';
    label = 'Not met';
  } else if (['no ticket', 'no_ticket', 'n/a', 'na', 'none'].some((s) => raw.includes(s))) {
    tone = 'neutral';
    label = 'N/A';
  }

  return { ticket: entry.ticket, label, tone, detail };
}

export function ticketToneClass(tone: TicketComplianceTone): string {
  switch (tone) {
    case 'positive':
      return 'text-emerald-400';
    case 'partial':
      return 'text-amber-400';
    case 'negative':
      return 'text-destructive';
    default:
      return 'text-muted-foreground';
  }
}

export function ticketToneIcon(tone: TicketComplianceTone): string {
  switch (tone) {
    case 'positive':
      return '✓';
    case 'partial':
      return '~';
    case 'negative':
      return '✗';
    default:
      return '·';
  }
}
