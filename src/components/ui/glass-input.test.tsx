import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GlassInput } from './glass-input';

describe('GlassInput', () => {
  it('renders md size classes by default', () => {
    render(<GlassInput data-testid="input" />);
    const input = screen.getByTestId('input');
    expect(input.className).toContain('w-full');
    expect(input.className).toContain('px-3');
    expect(input.className).toContain('py-2');
    expect(input.className).toContain('text-sm');
    expect(input.className).toContain('bg-[#0B0C0F]');
    expect(input.className).toContain('border-glass-edge');
  });

  it('renders sm size classes', () => {
    render(<GlassInput data-testid="input" fieldSize="sm" />);
    const input = screen.getByTestId('input');
    expect(input.className).toContain('px-2');
    expect(input.className).toContain('py-1');
    expect(input.className).toContain('text-xs');
  });

  it('merges caller className', () => {
    render(<GlassInput data-testid="input" className="flex-1 custom" />);
    expect(screen.getByTestId('input').className).toContain('flex-1');
    expect(screen.getByTestId('input').className).toContain('custom');
  });
});
