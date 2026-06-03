import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReviewProgressBar } from './ReviewProgressBar';

describe('ReviewProgressBar', () => {
  it('renders progressbar with correct aria values', () => {
    render(<ReviewProgressBar done={3} total={10} data-testid="prog" />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('3');
    expect(bar.getAttribute('aria-valuemax')).toBe('10');
  });
});
