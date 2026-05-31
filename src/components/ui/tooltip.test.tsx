import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InfoTooltip } from './tooltip';

describe('InfoTooltip', () => {
  it('hides the bubble until the trigger is hovered or focused', async () => {
    const user = userEvent.setup();
    render(<InfoTooltip content="Explains the thing" label="About thing" />);

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    await user.hover(screen.getByRole('button', { name: /about thing/i }));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Explains the thing');

    await user.unhover(screen.getByRole('button', { name: /about thing/i }));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('reveals the bubble on keyboard focus', async () => {
    const user = userEvent.setup();
    render(<InfoTooltip content="Keyboard reachable" />);
    await user.tab();
    expect(screen.getByRole('tooltip')).toHaveTextContent('Keyboard reachable');
  });
});
