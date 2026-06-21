/**
 * src/components/orchestrator/SpecCard.test.tsx
 *
 * Tests for SpecCard (SHR-143 workflow kind):
 *  - Shows a loading skeleton while fetching.
 *  - Renders spec text fetched from the artifact endpoint.
 *  - Shows an error state when fetch fails.
 *  - "Done reviewing" button calls onDismiss (no PUT, no ws event).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import { SpecCard, type SpecCardProps } from './SpecCard';
import { renderWithRouter } from '../../test-helpers';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SPEC_TEXT = `# Goal
Add rate-limit middleware to the Express API.

## Acceptance criteria
- Requests exceeding 100 req/min return 429.
- Limits are per-IP.

## Non-goals
- Redis-backed distributed rate limiting (future work).
`;

const BASE_PROPS: SpecCardProps = {
  cardId: 'card-spec-abc',
  taskId: 'task-xyz789',
  specPath: 'spec.md',
  artifactUrl: '/api/orchestrator/artifact?task=task-xyz789&path=spec.md',
  onDismiss: vi.fn(),
};

// ─── fetch mock helpers ────────────────────────────────────────────────────────

function makeFetchOkText(body: string) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => body,
    json: async () => ({}),
  } as unknown as Response);
}

function makeFetchFail(status = 500, message = 'Internal Server Error') {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    headers: { get: () => null },
    text: async () => message,
    json: async () => ({ error: message }),
  } as unknown as Response);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SpecCard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a loading skeleton while fetching the spec', () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    renderWithRouter(<SpecCard {...BASE_PROPS} />);
    expect(screen.getByRole('status', { name: /loading spec/i })).toBeInTheDocument();
  });

  it('renders spec text from the artifact endpoint', async () => {
    vi.stubGlobal('fetch', makeFetchOkText(SPEC_TEXT));
    renderWithRouter(<SpecCard {...BASE_PROPS} />);

    await waitFor(() => {
      expect(screen.getByTestId('spec-content')).toBeInTheDocument();
    });
    expect(screen.getByTestId('spec-content').textContent).toContain('Add rate-limit middleware');
    expect(screen.getByTestId('spec-content').textContent).toContain('Acceptance criteria');
  });

  it('shows a "Done reviewing" button', async () => {
    vi.stubGlobal('fetch', makeFetchOkText(SPEC_TEXT));
    renderWithRouter(<SpecCard {...BASE_PROPS} />);

    await waitFor(() => screen.getByTestId('spec-card'));
    expect(screen.getByRole('button', { name: /done reviewing/i })).toBeInTheDocument();
  });

  it('"Done reviewing" calls onDismiss without making a PUT request', async () => {
    const onDismiss = vi.fn();
    const fetchMock = makeFetchOkText(SPEC_TEXT);
    vi.stubGlobal('fetch', fetchMock);

    renderWithRouter(<SpecCard {...BASE_PROPS} onDismiss={onDismiss} />);

    await waitFor(() => screen.getByTestId('spec-card'));

    const dismissBtn = screen.getByRole('button', { name: /done reviewing/i });
    await act(async () => {
      fireEvent.click(dismissBtn);
    });

    // onDismiss was called
    expect(onDismiss).toHaveBeenCalledTimes(1);

    // No PUT was made — only the initial GET
    const allCalls = (fetchMock as ReturnType<typeof vi.fn>).mock.calls as Array<
      [string, RequestInit?]
    >;
    const putCall = allCalls.find(([, opts]) => (opts?.method ?? 'GET').toUpperCase() === 'PUT');
    expect(putCall).toBeUndefined();
  });

  it('shows an error state when the artifact fetch fails', async () => {
    vi.stubGlobal('fetch', makeFetchFail(500));
    renderWithRouter(<SpecCard {...BASE_PROPS} />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert').textContent).toContain('Failed to load spec');
  });

  it('renders the header label "Spec — read only"', async () => {
    vi.stubGlobal('fetch', makeFetchOkText(SPEC_TEXT));
    renderWithRouter(<SpecCard {...BASE_PROPS} />);

    await waitFor(() => screen.getByTestId('spec-card'));
    expect(screen.getByText(/spec — read only/i)).toBeInTheDocument();
  });
});
