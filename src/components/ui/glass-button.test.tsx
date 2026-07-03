import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GlassButton } from './glass-button';

describe('GlassButton', () => {
  it('renders primary dialog variant by default', () => {
    render(<GlassButton>Save</GlassButton>);
    const btn = screen.getByRole('button', { name: 'Save' });
    expect(btn.className).toContain('bg-[#3B82F6]');
    expect(btn.className).toContain('py-1.5');
  });

  it('renders cancel and destructive variants', () => {
    render(
      <>
        <GlassButton variant="cancel">Cancel</GlassButton>
        <GlassButton variant="destructive">Delete</GlassButton>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Cancel' }).className).toContain('text-[#b5b5bd]');
    expect(screen.getByRole('button', { name: 'Delete' }).className).toContain('bg-red-600');
  });

  it('calls onClick when enabled', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<GlassButton onClick={onClick}>Go</GlassButton>);
    await user.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
