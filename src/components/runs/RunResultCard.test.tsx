import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { RunResultCard } from './RunResultCard';

describe('RunResultCard', () => {
  it('renders the summary and outcome', () => {
    render(<RunResultCard result={{ outcome: 'done', summary: 'Fixed 3 doc drifts' }} />);
    expect(screen.getByText('Fixed 3 doc drifts')).toBeInTheDocument();
    expect(screen.getByText('done')).toBeInTheDocument();
  });

  it('renders links as anchors', () => {
    render(
      <RunResultCard
        result={{
          outcome: 'done',
          summary: 'x',
          links: [{ label: 'PR #12', url: 'https://e/12' }],
        }}
      />,
    );
    expect(screen.getByRole('link', { name: 'PR #12' })).toHaveAttribute('href', 'https://e/12');
  });
});
