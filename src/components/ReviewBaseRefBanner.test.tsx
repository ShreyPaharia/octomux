import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReviewBaseRefBanner } from './ReviewBaseRefBanner.js';

describe('ReviewBaseRefBanner', () => {
  it('renders ref, total, and reviewed count', () => {
    render(
      <ReviewBaseRefBanner
        baseRef="origin/main"
        baseIsStale={false}
        totalCount={12}
        reviewedCount={5}
        onRefresh={() => {}}
        onJumpToNextUnreviewed={() => {}}
      />,
    );
    expect(screen.getByText(/origin\/main/)).toBeInTheDocument();
    expect(screen.getByText(/12 files/)).toBeInTheDocument();
    expect(screen.getByText(/5 reviewed/)).toBeInTheDocument();
  });

  it('shows offline indicator when baseIsStale=true', () => {
    render(
      <ReviewBaseRefBanner
        baseRef="abc1234"
        baseIsStale={true}
        totalCount={1}
        reviewedCount={0}
        onRefresh={() => {}}
        onJumpToNextUnreviewed={() => {}}
      />,
    );
    expect(screen.getByText(/Using local base/i)).toBeInTheDocument();
  });

  it('calls onRefresh when refresh button is clicked', () => {
    const onRefresh = vi.fn();
    render(
      <ReviewBaseRefBanner
        baseRef="origin/main"
        baseIsStale={false}
        totalCount={1}
        reviewedCount={0}
        onRefresh={onRefresh}
        onJumpToNextUnreviewed={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /refresh base/i }));
    expect(onRefresh).toHaveBeenCalled();
  });

  it('clicking "X reviewed" jumps to next unreviewed', () => {
    const onJump = vi.fn();
    render(
      <ReviewBaseRefBanner
        baseRef="origin/main"
        baseIsStale={false}
        totalCount={3}
        reviewedCount={1}
        onRefresh={() => {}}
        onJumpToNextUnreviewed={onJump}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /1 reviewed/ }));
    expect(onJump).toHaveBeenCalled();
  });
});
