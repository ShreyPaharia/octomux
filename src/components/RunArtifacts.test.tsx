import { describe, it, expect } from '../bun-test.js';
import { render, screen } from '@testing-library/react';
import { RunArtifacts } from './RunArtifacts';
import type { RunArtifact } from '@/lib/api/runApi';

function makeArtifact(overrides: Partial<RunArtifact> = {}): RunArtifact {
  return {
    pluginId: 'coverage-bot',
    name: 'coverage.md',
    mime: 'text/markdown',
    size: 1234,
    updatedAt: '2026-08-21 10:00:00',
    url: '/api/tasks/t1/artifacts/coverage-bot/coverage.md',
    ...overrides,
  };
}

describe('RunArtifacts', () => {
  it('renders nothing when there are no artifacts', () => {
    const { container } = render(<RunArtifacts artifacts={[]} />);
    expect(container.querySelector('[data-testid="run-artifacts"]')).toBeNull();
  });

  it('renders one row per artifact with the right href, plugin id and formatted size', () => {
    render(<RunArtifacts artifacts={[makeArtifact()]} />);

    const link = screen.getByRole('link', { name: 'coverage.md' });
    expect(link.getAttribute('href')).toBe('/api/tasks/t1/artifacts/coverage-bot/coverage.md');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer noopener');
    expect(screen.getByText('coverage-bot')).toBeTruthy();
    expect(screen.getByText('1.2 KB')).toBeTruthy();
  });

  it('renders two plugins writing the same name as distinguishable rows keyed by pluginId+name', () => {
    const artifacts = [
      makeArtifact({ pluginId: 'plugin-a', url: '/api/tasks/t1/artifacts/plugin-a/report.md' }),
      makeArtifact({ pluginId: 'plugin-b', url: '/api/tasks/t1/artifacts/plugin-b/report.md' }),
    ].map((a) => ({ ...a, name: 'report.md' }));

    render(<RunArtifacts artifacts={artifacts} />);

    const links = screen.getAllByRole('link', { name: 'report.md' });
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.getAttribute('href')).sort()).toEqual([
      '/api/tasks/t1/artifacts/plugin-a/report.md',
      '/api/tasks/t1/artifacts/plugin-b/report.md',
    ]);
    expect(screen.getByText('plugin-a')).toBeTruthy();
    expect(screen.getByText('plugin-b')).toBeTruthy();
  });
});
