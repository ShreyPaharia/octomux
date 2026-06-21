/**
 * src/components/orchestrator/Markdown.test.tsx
 *
 * SHR-161 — assistant markdown renders safely (no XSS).
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Markdown } from './Markdown';

describe('Markdown (SHR-161)', () => {
  it('renders basic markdown to HTML elements', () => {
    const { container } = render(<Markdown>{'**bold** and `code`'}</Markdown>);
    expect(container.querySelector('strong')).toHaveTextContent('bold');
    expect(container.querySelector('code')).toHaveTextContent('code');
  });

  it('renders links with safe rel/target', () => {
    render(<Markdown>{'[ostium](https://ostium.io)'}</Markdown>);
    const link = screen.getByRole('link', { name: 'ostium' });
    expect(link).toHaveAttribute('href', 'https://ostium.io');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('does not render raw HTML (no XSS via embedded markup)', () => {
    const { container } = render(
      <Markdown>{'hello <img src=x onerror="alert(1)"> <b>x</b>'}</Markdown>,
    );
    // Raw HTML is not parsed into elements — no img/onerror leaks through.
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toContain('onerror');
  });

  it('strips javascript: URLs from links', () => {
    const { container } = render(<Markdown>{'[x](javascript:alert(1))'}</Markdown>);
    const anchor = container.querySelector('a');
    // rehype-sanitize drops the unsafe href (no javascript: scheme survives).
    expect(anchor?.getAttribute('href') ?? '').not.toContain('javascript:');
  });
});
