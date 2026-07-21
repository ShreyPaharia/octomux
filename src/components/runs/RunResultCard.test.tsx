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

  it('renders kind-specific output fields beyond the envelope', () => {
    render(
      <RunResultCard
        result={{
          outcome: 'done',
          summary: 'x',
          period: 'Jul 14 - Jul 20',
          highlights: ['shipped runs feed'],
        }}
      />,
    );
    expect(screen.getByText('Period')).toBeInTheDocument();
    expect(screen.getByText('Jul 14 - Jul 20')).toBeInTheDocument();
    expect(screen.getByText('shipped runs feed')).toBeInTheDocument();
  });

  it('renders nested object arrays without printing [object Object]', () => {
    const { container } = render(
      <RunResultCard
        result={{
          outcome: 'done',
          summary: 'x',
          themes: [{ title: 'Automation', items: ['new cron handler'] }],
        }}
      />,
    );
    expect(screen.getByText('Automation')).toBeInTheDocument();
    expect(screen.getByText('new cron handler')).toBeInTheDocument();
    expect(container.textContent).not.toContain('[object Object]');
  });
});
