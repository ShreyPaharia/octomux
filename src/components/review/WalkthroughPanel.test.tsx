import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WalkthroughPanel } from './WalkthroughPanel';

const WT = {
  global: {
    type: 'Enhancement',
    risk: 'medium',
    effort: 3,
    relevant_tests: 'yes',
    security_concerns: null,
    summary: 'This PR refactors X. It also changes Y in depth.',
    key_review_points: ['watch adapter.go', 'verify parser semantics'],
    ticket_compliance: [
      { ticket: 'PROJ-1', status: 'addressed', notes: 'Fully implemented.' },
      { ticket: 'PROJ-2', status: 'non-compliant' },
    ],
  },
};

describe('WalkthroughPanel', () => {
  beforeEach(() => {
    localStorage.removeItem('octomux:review:walkthrough-expanded');
  });

  it('renders scalar pills and expanded body by default', () => {
    render(<WalkthroughPanel walkthrough={WT} />);
    expect(screen.getByText('Enhancement')).toBeTruthy();
    expect(screen.getByText(/risk: medium/)).toBeTruthy();
    expect(screen.getByText(/effort 3\/5/)).toBeTruthy();
    expect(screen.getByText(/This PR refactors X/)).toBeTruthy();
    expect(screen.getByText('watch adapter.go')).toBeTruthy();
    expect(screen.getByText(/PROJ-1/)).toBeTruthy();
    expect(screen.getByText(/Met/)).toBeTruthy();
    expect(screen.getByText(/Fully implemented/)).toBeTruthy();
    expect(screen.getByText(/Not met/)).toBeTruthy();
  });

  it('collapses to preview and hides key points', async () => {
    const user = userEvent.setup();
    render(<WalkthroughPanel walkthrough={WT} />);
    await user.click(screen.getByRole('button', { name: 'Collapse walkthrough' }));
    expect(screen.queryByTestId('walkthrough-key-points')).toBeNull();
    expect(screen.getByText(/2 focus areas/)).toBeTruthy();
    expect(screen.getByText(/This PR refactors X/)).toBeTruthy();
  });

  it('renders null when there is no useful content', () => {
    const { container } = render(<WalkthroughPanel walkthrough={{}} />);
    expect(container.firstChild).toBeNull();
  });
});
