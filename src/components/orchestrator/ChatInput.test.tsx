import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatInput } from './ChatInput';

describe('ChatInput', () => {
  it('submits trimmed text on Enter and clears the field', () => {
    const onSubmit = vi.fn();
    render(<ChatInput onSubmit={onSubmit} />);

    const input = screen.getByLabelText('Message input');
    fireEvent.change(input, { target: { value: '  hello  ' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

    expect(onSubmit).toHaveBeenCalledWith('hello');
    expect(input).toHaveValue('');
  });

  it('does not submit when disabled', () => {
    const onSubmit = vi.fn();
    render(<ChatInput onSubmit={onSubmit} disabled />);

    const input = screen.getByLabelText('Message input');
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

    expect(onSubmit).not.toHaveBeenCalled();
  });
});
