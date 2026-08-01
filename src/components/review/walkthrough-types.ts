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

export interface WalkthroughTicketRaw {
  ticket: string;
  status: string;
  notes?: string;
  reason?: string;
}

export interface WalkthroughGlobal {
  type?: string;
  risk?: string;
  effort?: number;
  relevant_tests?: string;
  security_concerns?: string | null;
  ticket_compliance?: WalkthroughTicketRaw[];
  summary?: string;
  /** Legacy: superseded by top-level `highlights`. Kept optional so old runs still parse. */
  key_review_points?: string[];
}

/** A ranked, code-linked "look at this" — the pyramid's middle tier. */
export interface WalkthroughHighlight {
  title: string;
  file: string;
  line?: number;
  side?: 'old' | 'new';
  detail?: string;
}

export interface Walkthrough {
  /** One-line verdict: what this PR does + its risk. */
  verdict?: string;
  /** ≤5 ranked, code-linked highlights. */
  highlights?: WalkthroughHighlight[];
  global?: WalkthroughGlobal;
  groups?: WalkthroughGroup[];
}
