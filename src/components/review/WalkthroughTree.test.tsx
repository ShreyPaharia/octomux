import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WalkthroughTree } from './WalkthroughTree';

vi.mock('@/lib/api', () => ({ api: { patchWalkthrough: vi.fn().mockResolvedValue({}) } }));

const WT = {
  global: {
    type: 'Enhancement',
    risk: 'low',
    effort: 2,
    relevant_tests: 'yes',
    security_concerns: null,
    ticket_compliance: [],
    summary: 'adds X',
    key_review_points: ['look at Y'],
  },
  groups: [
    {
      name: 'Schema',
      summary: 's',
      files: [{ path: 'a.ts', label: 'dependencies', summary: 'd' }],
    },
  ],
};

describe('WalkthroughTree', () => {
  it('renders scalar pill bar with type, risk, effort, tests', () => {
    render(<WalkthroughTree walkthrough={WT} onEditSection={() => {}} />);
    expect(screen.getByText('Enhancement')).toBeTruthy();
    expect(screen.getByText(/Effort 2\/5/)).toBeTruthy();
    expect(screen.getByText(/Tests: yes/)).toBeTruthy();
    expect(screen.getByText(/Risk: low/)).toBeTruthy();
  });

  it('renders summary and key review points', () => {
    render(<WalkthroughTree walkthrough={WT} onEditSection={() => {}} />);
    expect(screen.getByText('adds X')).toBeTruthy();
    expect(screen.getByText('look at Y')).toBeTruthy();
  });

  it('renders groups and files', () => {
    render(<WalkthroughTree walkthrough={WT} onEditSection={() => {}} />);
    expect(screen.getByText('Schema')).toBeTruthy();
    expect(screen.getByText('a.ts')).toBeTruthy();
    expect(screen.getByText('dependencies')).toBeTruthy();
  });

  it('shows ticket_compliance pill when entries exist', () => {
    const wt = {
      ...WT,
      global: {
        ...WT.global,
        ticket_compliance: [{ ticket: 'IN-1', status: 'partially' as const }],
      },
    };
    render(<WalkthroughTree walkthrough={wt} onEditSection={() => {}} />);
    expect(screen.getByText('IN-1')).toBeTruthy();
    expect(screen.getByText('partially')).toBeTruthy();
  });

  it('does not render security pill when null', () => {
    render(<WalkthroughTree walkthrough={WT} onEditSection={() => {}} />);
    expect(screen.queryByText(/Security:/)).toBeNull();
  });
});
