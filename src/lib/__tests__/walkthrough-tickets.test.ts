import { describe, it, expect } from 'vitest';
import { normalizeTicketCompliance } from '../walkthrough-tickets';

describe('normalizeTicketCompliance', () => {
  it.each([
    ['addressed', 'positive', 'Met'],
    ['satisfied', 'positive', 'Met'],
    ['compliant', 'positive', 'Met'],
    ['partially', 'partial', 'Partial'],
    ['non-compliant', 'negative', 'Not met'],
    ['no_ticket', 'neutral', 'N/A'],
  ] as const)('maps %s → %s (%s)', (status, tone, label) => {
    const n = normalizeTicketCompliance({ ticket: 'BAC-1', status });
    expect(n.tone).toBe(tone);
    expect(n.label).toBe(label);
  });

  it('prefers notes over reason for detail', () => {
    const n = normalizeTicketCompliance({
      ticket: 'IN-1',
      status: 'addressed',
      notes: 'Scope matches.',
      reason: 'ignored',
    });
    expect(n.detail).toBe('Scope matches.');
  });
});
