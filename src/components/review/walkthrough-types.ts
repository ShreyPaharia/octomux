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
  key_review_points?: string[];
}

export interface Walkthrough {
  global?: WalkthroughGlobal;
  groups?: WalkthroughGroup[];
}
