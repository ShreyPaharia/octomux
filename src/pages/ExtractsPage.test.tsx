import { describe, it, expect, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import ExtractsPage from './ExtractsPage';
import { renderWithRouter } from '../test-helpers';
import type { PrExtract } from '@/lib/api/extractApi';

const { taskApiProxy, reviewApiProxy, configApiProxy, loopApiProxy, extractApiProxy, apiMock } =
  await vi.hoisted(async () => (await import('../test-helpers')).setupApiMock());

vi.mock('@/lib/api/taskApi', () => ({ taskApi: taskApiProxy }));
vi.mock('@/lib/api/reviewApi', () => ({ reviewApi: reviewApiProxy }));
vi.mock('@/lib/api/configApi', () => ({ configApi: configApiProxy }));
vi.mock('@/lib/api/loopApi', () => ({ loopApi: loopApiProxy }));
vi.mock('@/lib/api/extractApi', () => ({ extractApi: extractApiProxy }));
vi.mock('@/lib/event-source', () => ({
  subscribe: vi.fn(() => () => {}),
  subscribeConnectionState: vi.fn(() => () => {}),
}));

function makeExtract(overrides: Partial<PrExtract> = {}): PrExtract {
  return {
    id: 'ext-1',
    task_id: 'task-1',
    repo_path: '/repo',
    pr_number: 42,
    pr_head_sha: 'sha-abc',
    area: 'server',
    risk: 'high',
    has_migration: true,
    surface: 'api',
    loc: 120,
    created_at: '2026-01-01 00:00:00',
    ...overrides,
  };
}

describe('ExtractsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders an empty state with no extracts', async () => {
    apiMock.listExtracts.mockResolvedValue([]);
    renderWithRouter(<ExtractsPage />);
    expect(await screen.findByText(/no extracts yet/i)).toBeTruthy();
  });

  it('renders a row per extract with its fields', async () => {
    apiMock.listExtracts.mockResolvedValue([makeExtract()]);
    renderWithRouter(<ExtractsPage />);

    expect(await screen.findByTestId('extract-row-ext-1')).toBeTruthy();
    expect(screen.getByText(/#42/)).toBeTruthy();
    expect(screen.getByText('high')).toBeTruthy();
    expect(screen.getByText(/area: server/i)).toBeTruthy();
  });
});
