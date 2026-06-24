import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { StatusIcon } from './glyphs';
import type { SidebarItem } from '@/lib/sidebar-utils';

function item(overrides: Partial<SidebarItem> = {}): SidebarItem {
  return {
    id: 'x',
    title: 'T',
    status: 'idle',
    derivedStatus: null,
    runMode: 'new',
    repoPath: '/r',
    ...overrides,
  };
}

describe('StatusIcon', () => {
  it.each<{ name: string; item: Partial<SidebarItem>; glyph: string }>([
    { name: 'running', item: { status: 'running' }, glyph: 'running' },
    { name: 'working (derived)', item: { derivedStatus: 'working' }, glyph: 'running' },
    { name: 'setting_up', item: { status: 'setting_up' }, glyph: 'setting_up' },
    { name: 'needs_attention', item: { derivedStatus: 'needs_attention' }, glyph: 'needs-you' },
    { name: 'error', item: { status: 'error' }, glyph: 'error' },
    { name: 'idle (default)', item: { status: 'idle' }, glyph: 'idle' },
  ])('renders data-status-glyph=$glyph for $name', ({ item: overrides, glyph }) => {
    const { container } = render(<StatusIcon item={item(overrides)} />);
    expect(container.querySelector(`[data-status-glyph="${glyph}"]`)).toBeTruthy();
  });

  it('prefers derivedStatus over status', () => {
    const { container } = render(
      <StatusIcon item={item({ status: 'running', derivedStatus: 'needs_attention' })} />,
    );
    expect(container.querySelector('[data-status-glyph="needs-you"]')).toBeTruthy();
    expect(container.querySelector('[data-status-glyph="running"]')).toBeNull();
  });
});
