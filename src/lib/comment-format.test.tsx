import { describe, it, expect } from 'vitest';
import { isValidElement } from 'react';
import { linkify } from './comment-format';

describe('linkify', () => {
  it('returns the original text unchanged when there are no URLs', () => {
    const out = linkify('hello world');
    expect(out).toEqual(['hello world']);
  });

  it('returns the empty input as-is', () => {
    const out = linkify('');
    expect(out).toEqual(['']);
  });

  it('wraps a single URL in an anchor', () => {
    const out = linkify('see https://example.com for details');
    expect(out).toHaveLength(3);
    expect(out[0]).toBe('see ');
    expect(isValidElement(out[1])).toBe(true);
    const anchor = out[1] as React.ReactElement<{ href: string; children: string }>;
    expect(anchor.props.href).toBe('https://example.com');
    expect(anchor.props.children).toBe('https://example.com');
    expect(out[2]).toBe(' for details');
  });

  it('handles multiple URLs', () => {
    const out = linkify('http://a.test then https://b.test');
    const anchors = out.filter(isValidElement);
    expect(anchors).toHaveLength(2);
  });

  it('does not match plain text that looks like a URL fragment', () => {
    const out = linkify('foo://bar');
    expect(out).toEqual(['foo://bar']);
  });
});
