import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RejectDialog } from './RejectDialog';

describe('RejectDialog', () => {
  it('does not render when open=false', () => {
    render(<RejectDialog open={false} onOpenChange={() => {}} onReject={async () => {}} />);
    expect(screen.queryByText('Reject comment')).toBeNull();
  });

  it('renders when open=true', () => {
    render(<RejectDialog open={true} onOpenChange={() => {}} onReject={async () => {}} />);
    expect(screen.getByText('Reject comment')).toBeTruthy();
    expect(screen.getByText('Reject only')).toBeTruthy();
    expect(screen.getByText('Reject + remember this')).toBeTruthy();
  });

  it('Reject + remember this is disabled when why is empty', () => {
    render(<RejectDialog open={true} onOpenChange={() => {}} onReject={async () => {}} />);
    const rememberBtn = screen.getByText('Reject + remember this').closest('button');
    expect(rememberBtn?.disabled).toBe(true);
  });

  it('Reject only calls onReject without why', async () => {
    const user = userEvent.setup();
    const onReject = vi.fn().mockResolvedValue(undefined);
    render(<RejectDialog open={true} onOpenChange={() => {}} onReject={onReject} />);
    await user.click(screen.getByText('Reject only'));
    expect(onReject).toHaveBeenCalledWith(undefined);
  });

  it('Reject + remember calls onReject with why text', async () => {
    const user = userEvent.setup();
    const onReject = vi.fn().mockResolvedValue(undefined);
    render(<RejectDialog open={true} onOpenChange={() => {}} onReject={onReject} />);
    await user.type(screen.getByPlaceholderText(/e.g./), 'we do this on purpose');
    await user.click(screen.getByText('Reject + remember this'));
    expect(onReject).toHaveBeenCalledWith('we do this on purpose');
  });
});
