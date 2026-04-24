import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusGlyph } from './status-glyph';

describe('StatusGlyph', () => {
  const cases: [string, string, string][] = [
    ['running', '●', 'rgb(34, 197, 94)'],
    ['working', '●', 'rgb(34, 197, 94)'],
    ['done', '●', 'rgb(34, 197, 94)'],
    ['awaiting', '▲', 'rgb(255, 184, 0)'],
    ['needs_attention', '▲', 'rgb(255, 184, 0)'],
    ['setting_up', '◐', 'rgb(255, 184, 0)'],
    ['error', '✕', 'rgb(239, 68, 68)'],
    ['closed', '○', 'rgb(106, 106, 106)'],
    ['draft', '○', 'rgb(106, 106, 106)'],
  ];

  it.each(cases)('renders status "%s" as glyph "%s" in color %s', (status, glyph, rgb) => {
    render(<StatusGlyph status={status} />);
    const el = screen.getByRole('img');
    expect(el.textContent).toBe(glyph);
    expect(el.dataset.glyph).toBe(glyph);
    expect(el.dataset.status).toBe(status);
    expect(el.style.color).toBe(rgb);
  });

  it('falls back to grey ○ for unknown status', () => {
    render(<StatusGlyph status="who_knows" />);
    const el = screen.getByRole('img');
    expect(el.textContent).toBe('○');
    expect(el.getAttribute('aria-label')).toBe('unknown');
  });

  it('uses default size of 10px', () => {
    render(<StatusGlyph status="running" />);
    const el = screen.getByRole('img');
    expect(el.style.fontSize).toBe('10px');
  });

  it('respects size prop', () => {
    render(<StatusGlyph status="running" size={16} />);
    const el = screen.getByRole('img');
    expect(el.style.fontSize).toBe('16px');
  });

  it('exposes status as accessible label and data-status', () => {
    render(<StatusGlyph status="needs_attention" />);
    const el = screen.getByRole('img');
    expect(el.getAttribute('aria-label')).toBe('needs attention');
    expect(el.dataset.status).toBe('needs_attention');
  });

  it('merges caller className', () => {
    render(<StatusGlyph status="running" className="ml-2 custom" />);
    const el = screen.getByRole('img');
    expect(el.className).toContain('ml-2');
    expect(el.className).toContain('custom');
  });
});
