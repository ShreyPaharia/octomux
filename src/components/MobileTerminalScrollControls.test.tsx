import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MobileTerminalScrollControls } from './MobileTerminalScrollControls';

describe('MobileTerminalScrollControls', () => {
  it('calls scroll handlers when buttons are tapped', async () => {
    const user = userEvent.setup();
    const onScrollOlder = vi.fn();
    const onScrollNewer = vi.fn();
    const onScrollToBottom = vi.fn();

    render(
      <MobileTerminalScrollControls
        onScrollOlder={onScrollOlder}
        onScrollNewer={onScrollNewer}
        onScrollToBottom={onScrollToBottom}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Older output' }));
    await user.click(screen.getByRole('button', { name: 'Newer output' }));
    await user.click(screen.getByRole('button', { name: 'Jump to latest output' }));

    expect(onScrollOlder).toHaveBeenCalledOnce();
    expect(onScrollNewer).toHaveBeenCalledOnce();
    expect(onScrollToBottom).toHaveBeenCalledOnce();
  });
});
