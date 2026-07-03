import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { SetupBanner } from './SetupBanner';
import { renderWithRouter } from '../test-helpers';

const apiMock = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getSetupStatus: vi.fn(),
}));

vi.mock('@/lib/api/configApi', () => ({ configApi: apiMock }));
vi.mock('@/lib/api/taskApi', () => ({ taskApi: {} }));
vi.mock('@/lib/api/reviewApi', () => ({ reviewApi: {} }));

function setupStatus(blockerCount: number, attentionCount: number) {
  return {
    items: [],
    summary: { ready: blockerCount === 0, blockerCount, attentionCount },
    platform: 'darwin',
    hasBrew: true,
  };
}

describe('SetupBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getSettings.mockResolvedValue({});
  });

  it('shows when a required dependency is missing (blocker)', async () => {
    apiMock.getSetupStatus.mockResolvedValue(setupStatus(1, 3));
    renderWithRouter(<SetupBanner />);
    const banner = await screen.findByTestId('setup-banner');
    expect(banner).toHaveTextContent('1 required setup item need attention');
  });

  it('does NOT show when only optional/attention items remain', async () => {
    apiMock.getSetupStatus.mockResolvedValue(setupStatus(0, 2));
    renderWithRouter(<SetupBanner />);
    await waitFor(() => expect(apiMock.getSetupStatus).toHaveBeenCalled());
    expect(screen.queryByTestId('setup-banner')).not.toBeInTheDocument();
  });

  it('does NOT show once onboarding has been dismissed', async () => {
    apiMock.getSettings.mockResolvedValue({ onboardingCompletedAt: '2026-01-01T00:00:00Z' });
    apiMock.getSetupStatus.mockResolvedValue(setupStatus(2, 2));
    renderWithRouter(<SetupBanner />);
    await waitFor(() => expect(apiMock.getSettings).toHaveBeenCalled());
    expect(screen.queryByTestId('setup-banner')).not.toBeInTheDocument();
  });
});
