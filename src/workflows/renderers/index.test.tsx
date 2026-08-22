import { describe, it, expect } from '../../bun-test.js';
import { render, screen } from '@testing-library/react';
import { getRenderer } from './index';
import type { RecordEnvelope, UiContribution } from '@/lib/plugin-ui';

function makeContribution(overrides: Partial<UiContribution> = {}): UiContribution {
  return {
    pluginId: 'coverage-bot',
    slot: 'task.panel',
    record: 'coverage',
    recordStore: 'coverage-bot:coverage',
    as: 'stat',
    ...overrides,
  };
}

function makeRecord(overrides: Partial<RecordEnvelope> = {}): RecordEnvelope {
  return {
    seq: 1,
    store: 'coverage-bot:coverage',
    taskId: 'task-1',
    key: null,
    payload: { value: 87 },
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

const RENDERER_NAMES = ['stat', 'table', 'timeline', 'badge', 'markdown', 'json', 'diff', 'log'];

describe('workflows/renderers', () => {
  it.each(RENDERER_NAMES.map((name) => [name] as const))(
    'resolves a component for the "%s" renderer',
    (name) => {
      const Renderer = getRenderer(name);
      const contribution = makeContribution({ as: name });
      const { container } = render(
        <Renderer contribution={contribution} records={[makeRecord()]} />,
      );
      expect(container.textContent).not.toBe('');
    },
  );

  it('degrades an unknown renderer name to json, never a blank panel', () => {
    const Renderer = getRenderer('some-future-renderer');
    const contribution = makeContribution({ as: 'some-future-renderer' });
    render(
      <Renderer contribution={contribution} records={[makeRecord({ payload: { pct: 42 } })]} />,
    );
    // json renderer pretty-prints the payload — the value must be visible.
    expect(screen.getByText(/"pct": 42/)).toBeTruthy();
  });

  it('json renderer is literally what getRenderer("json") returns', () => {
    expect(getRenderer('json')).toBe(getRenderer('totally-unknown'));
  });

  it('every renderer shows an empty state instead of blank with no records', () => {
    for (const name of RENDERER_NAMES) {
      const Renderer = getRenderer(name);
      const { container, unmount } = render(
        <Renderer contribution={makeContribution({ as: name })} records={[]} />,
      );
      expect(container.textContent).not.toBe('');
      unmount();
    }
  });

  it('stat renderer reads the declared value/delta keys', () => {
    const Renderer = getRenderer('stat');
    const contribution = makeContribution({ as: 'stat', value: 'pct', delta: 'change' });
    render(
      <Renderer
        contribution={contribution}
        records={[makeRecord({ payload: { pct: 91, change: '+4' } })]}
      />,
    );
    expect(screen.getByText('91')).toBeTruthy();
    expect(screen.getByText('+4')).toBeTruthy();
  });

  it('table renderer renders an array payload as rows', () => {
    const Renderer = getRenderer('table');
    render(
      <Renderer
        contribution={makeContribution({ as: 'table' })}
        records={[
          makeRecord({
            payload: [
              { file: 'a.ts', pct: 90 },
              { file: 'b.ts', pct: 80 },
            ],
          }),
        ]}
      />,
    );
    expect(screen.getByText('a.ts')).toBeTruthy();
    expect(screen.getByText('b.ts')).toBeTruthy();
  });

  it('badge renderer renders the primary value in a Badge', () => {
    const Renderer = getRenderer('badge');
    render(
      <Renderer
        contribution={makeContribution({ as: 'badge' })}
        records={[makeRecord({ payload: { value: 'green' } })]}
      />,
    );
    expect(screen.getByText('green')).toBeTruthy();
  });
});
