// src/components/EmptyState.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  const icon = <svg data-testid="empty-icon" />;

  it('renders heading and icon', () => {
    render(<EmptyState icon={icon} heading="Nothing here" />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.getByTestId('empty-icon')).toBeInTheDocument();
  });

  it('renders optional subtext', () => {
    render(<EmptyState icon={icon} heading="Empty" subtext="Try something" />);
    expect(screen.getByText('Try something')).toBeInTheDocument();
  });

  it('does not render subtext when omitted', () => {
    render(<EmptyState icon={icon} heading="Empty" />);
    expect(screen.queryByText('Try something')).not.toBeInTheDocument();
  });

  it('renders optional action', () => {
    render(<EmptyState icon={icon} heading="Empty" action={<button>Do it</button>} />);
    expect(screen.getByRole('button', { name: 'Do it' })).toBeInTheDocument();
  });

  it('does not render action when omitted', () => {
    render(<EmptyState icon={icon} heading="Empty" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('applies custom className', () => {
    const { container } = render(
      <EmptyState icon={icon} heading="Empty" className="custom-class" />,
    );
    expect(container.firstChild).toHaveClass('custom-class');
  });
});
