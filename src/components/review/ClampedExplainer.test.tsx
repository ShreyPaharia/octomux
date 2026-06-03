import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClampedExplainer } from './ClampedExplainer';

describe('ClampedExplainer', () => {
  it('renders short text without a toggle', () => {
    render(<ClampedExplainer text="Short note." clampChars={140} />);
    expect(screen.getByText('Short note.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('expands long text on Show more', async () => {
    const user = userEvent.setup();
    const long = 'x'.repeat(200);
    render(<ClampedExplainer text={long} clampChars={100} />);
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy();
    expect(screen.getByText(long)).toBeTruthy();
  });
});
