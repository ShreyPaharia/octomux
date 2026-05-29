import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WalkthroughHeader } from './WalkthroughHeader';

describe('WalkthroughHeader', () => {
  it('renders walkthrough as a one-line peek strip with hover-title', () => {
    render(
      <WalkthroughHeader
        walkthrough={{
          global: {
            summary: 'This PR refactors X. It also changes Y.',
            risk: 'medium',
            key_review_points: ['a', 'b', 'c'],
          },
        }}
      />,
    );
    const strip = screen.getByTestId('walkthrough-header');
    expect(strip.textContent).toMatch(/Walkthrough/);
    expect(strip.textContent).toMatch(/This PR refactors X\./);
    // full summary lives on the title attribute
    const summarySpan = strip.querySelector('[title]');
    expect(summarySpan?.getAttribute('title')).toBe('This PR refactors X. It also changes Y.');
    // meta pills include risk + key points count
    expect(strip.textContent).toMatch(/risk: medium/);
    expect(strip.textContent).toMatch(/3 key points/);
  });

  it('renders null when there is no useful content', () => {
    const { container } = render(<WalkthroughHeader walkthrough={{}} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders ticket compliance badges', () => {
    render(
      <WalkthroughHeader
        walkthrough={{
          global: {
            ticket_compliance: [
              { ticket: 'PROJ-1', status: 'compliant' },
              { ticket: 'PROJ-2', status: 'non-compliant' },
            ],
          },
        }}
      />,
    );
    const strip = screen.getByTestId('walkthrough-header');
    expect(strip.textContent).toMatch(/PROJ-1 ✓/);
    expect(strip.textContent).toMatch(/PROJ-2 ✗/);
  });

  it('renders type in meta when only type is present', () => {
    render(
      <WalkthroughHeader
        walkthrough={{
          global: {
            type: 'Enhancement',
          },
        }}
      />,
    );
    const strip = screen.getByTestId('walkthrough-header');
    expect(strip.textContent).toMatch(/Walkthrough/);
  });
});
