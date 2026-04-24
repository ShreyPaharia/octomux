import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { GlassPanel } from './glass-panel';

describe('GlassPanel', () => {
  it('defaults to level 1 with l1 tint, l1 blur, and standard edge', () => {
    const { container } = render(<GlassPanel>content</GlassPanel>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.dataset.glassLevel).toBe('1');
    expect(el.className).toContain('bg-glass-l1');
    expect(el.className).toContain('glass-blur-l1');
    expect(el.className).toContain('border-glass-edge');
    expect(el.className).not.toContain('border-glass-edge-strong');
  });

  it('renders level 2 with l2 tint and l2 blur', () => {
    const { container } = render(<GlassPanel level={2}>x</GlassPanel>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.dataset.glassLevel).toBe('2');
    expect(el.className).toContain('bg-glass-l2');
    expect(el.className).toContain('glass-blur-l2');
    expect(el.className).toContain('border-glass-edge');
  });

  it('renders level 3 with l3 tint, l3 blur, and strong edge', () => {
    const { container } = render(<GlassPanel level={3}>x</GlassPanel>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.dataset.glassLevel).toBe('3');
    expect(el.className).toContain('bg-glass-l3');
    expect(el.className).toContain('glass-blur-l3');
    expect(el.className).toContain('border-glass-edge-strong');
  });

  it('applies inset specular highlight when specular is true', () => {
    const { container } = render(<GlassPanel specular>x</GlassPanel>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.dataset.glassSpecular).toBe('true');
    expect(el.style.boxShadow).toContain('inset');
    expect(el.style.boxShadow.toLowerCase()).toContain('rgba(255, 255, 255, 0.22)');
  });

  it('omits specular highlight by default', () => {
    const { container } = render(<GlassPanel>x</GlassPanel>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.dataset.glassSpecular).toBeUndefined();
    expect(el.style.boxShadow).toBe('');
  });

  it('merges caller className', () => {
    const { container } = render(<GlassPanel className="p-4 custom-x">x</GlassPanel>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain('p-4');
    expect(el.className).toContain('custom-x');
    expect(el.className).toContain('bg-glass-l1');
  });

  it('forwards arbitrary props onto the underlying div', () => {
    const { container } = render(
      <GlassPanel data-testid="panel" aria-label="surface">
        x
      </GlassPanel>,
    );
    const el = container.firstElementChild as HTMLElement;
    expect(el.getAttribute('data-testid')).toBe('panel');
    expect(el.getAttribute('aria-label')).toBe('surface');
  });
});
