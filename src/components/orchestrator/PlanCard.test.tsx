/**
 * src/components/orchestrator/PlanCard.test.tsx
 *
 * Tests for PlanCard (Task 2.6 / SHR-129):
 *  - Renders summary, file list, and steps fetched from the artifact endpoint.
 *  - File-level toggle (include/exclude) mutates the file list before approval.
 *  - Approve sends the edited plan to the artifact endpoint (PUT) and fires the
 *    ws card_decision event.
 *  - Reject fires card_decision without a PUT.
 *  - Shows an open_questions section when present.
 *  - Gracefully degrades to a prose fallback when plan.json doesn't validate.
 *  - Shows a loading skeleton while fetching.
 *  - Shows an error state when fetch fails.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import { PlanCard, type PlanCardProps } from './PlanCard';
import { renderWithRouter } from '../../test-helpers';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PLAN_JSON = {
  schema_version: '1.0.0',
  summary: 'Add rate-limit middleware to the Express app.',
  files: [
    {
      path: 'server/middleware/rate-limit.ts',
      action: 'create' as const,
      steps: ['Install express-rate-limit', 'Export applyRateLimit(app) function'],
    },
    {
      path: 'server/app.ts',
      action: 'modify' as const,
      steps: ['Import and apply rate-limit middleware'],
    },
    {
      path: 'server/old-rate-limit.ts',
      action: 'delete' as const,
    },
  ],
  open_questions: ['Which Redis instance should rate-limit use?'],
};

const BASE_PROPS: PlanCardProps = {
  cardId: 'card-abc123',
  taskId: 'task-xyz789',
  planPath: 'plan.json',
  artifactUrl: '/api/orchestrator/artifact?task=task-xyz789&path=plan.json',
  onDecision: vi.fn(),
};

// ─── fetch mock helpers ────────────────────────────────────────────────────────

function makeFetchOk(body: unknown, options: { etag?: string } = {}) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: {
      get: (h: string) => (h.toLowerCase() === 'etag' ? (options.etag ?? '"etag-v1"') : null),
    },
    json: async () => body,
  } as unknown as Response);
}

function makeFetchFail(status = 500, message = 'Internal Server Error') {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => ({ error: message }),
  } as unknown as Response);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PlanCard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a loading skeleton while fetching the plan', () => {
    // fetch never resolves → stays loading
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    renderWithRouter(<PlanCard {...BASE_PROPS} />);
    expect(screen.getByRole('status', { name: /loading plan/i })).toBeInTheDocument();
  });

  it('renders summary and file list from fetched plan.json', async () => {
    vi.stubGlobal('fetch', makeFetchOk(PLAN_JSON));
    renderWithRouter(<PlanCard {...BASE_PROPS} />);

    await waitFor(() => {
      expect(screen.getByText('Add rate-limit middleware to the Express app.')).toBeInTheDocument();
    });
    expect(screen.getByText('server/middleware/rate-limit.ts')).toBeInTheDocument();
    expect(screen.getByText('server/app.ts')).toBeInTheDocument();
    expect(screen.getByText('server/old-rate-limit.ts')).toBeInTheDocument();
  });

  it('renders action badges for each file', async () => {
    vi.stubGlobal('fetch', makeFetchOk(PLAN_JSON));
    renderWithRouter(<PlanCard {...BASE_PROPS} />);

    await waitFor(() => screen.getByText('server/middleware/rate-limit.ts'));

    // Should show action labels (create / modify / delete)
    expect(screen.getByText('create')).toBeInTheDocument();
    expect(screen.getByText('modify')).toBeInTheDocument();
    expect(screen.getByText('delete')).toBeInTheDocument();
  });

  it('renders steps when expanded', async () => {
    vi.stubGlobal('fetch', makeFetchOk(PLAN_JSON));
    renderWithRouter(<PlanCard {...BASE_PROPS} />);

    await waitFor(() => screen.getByText('server/middleware/rate-limit.ts'));

    // The first file row has steps — click to expand
    const fileRow = screen.getByTestId('file-row-server/middleware/rate-limit.ts');
    fireEvent.click(fileRow);

    await waitFor(() => {
      expect(screen.getByText('Install express-rate-limit')).toBeInTheDocument();
    });
    expect(screen.getByText('Export applyRateLimit(app) function')).toBeInTheDocument();
  });

  it('shows open_questions section when present', async () => {
    vi.stubGlobal('fetch', makeFetchOk(PLAN_JSON));
    renderWithRouter(<PlanCard {...BASE_PROPS} />);

    await waitFor(() => screen.getByText('Which Redis instance should rate-limit use?'));
  });

  it('toggles a file off and on (exclude/include)', async () => {
    vi.stubGlobal('fetch', makeFetchOk(PLAN_JSON));
    renderWithRouter(<PlanCard {...BASE_PROPS} />);

    await waitFor(() => screen.getByText('server/app.ts'));

    // Find the toggle checkbox for server/app.ts
    const checkbox = screen.getByRole('checkbox', { name: /server\/app\.ts/i });
    expect(checkbox).toBeChecked();

    // Toggle it off
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();

    // Toggle back on
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
  });

  it('approve PUTs the edited plan (with excluded files removed) then calls onDecision', async () => {
    const onDecision = vi.fn();
    // First call = GET plan; second call = PUT edited plan
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
      const method = (opts?.method ?? 'GET').toUpperCase();
      if (method === 'PUT') {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({ ok: true }),
        } as unknown as Response);
      }
      // GET
      callCount++;
      void callCount;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: (h: string) => (h.toLowerCase() === 'etag' ? '"etag-v1"' : null) },
        json: async () => PLAN_JSON,
      } as unknown as Response);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithRouter(<PlanCard {...BASE_PROPS} onDecision={onDecision} />);

    await waitFor(() => screen.getByText('server/app.ts'));

    // Exclude one file
    const checkbox = screen.getByRole('checkbox', { name: /server\/app\.ts/i });
    fireEvent.click(checkbox);

    // Approve
    const approveBtn = screen.getByRole('button', { name: /approve/i });
    await act(async () => {
      fireEvent.click(approveBtn);
    });

    // PUT should have been called with the modified plan (server/app.ts excluded)
    await waitFor(() => {
      const calls = fetchMock.mock.calls as Array<[string, RequestInit?]>;
      const putCall = calls.find(([, opts]) => (opts?.method ?? 'GET').toUpperCase() === 'PUT');
      expect(putCall).toBeDefined();
      const body = JSON.parse(putCall![1]!.body as string) as typeof PLAN_JSON;
      expect(body.files.find((f) => f.path === 'server/app.ts')).toBeUndefined();
      expect(body.files.find((f) => f.path === 'server/middleware/rate-limit.ts')).toBeDefined();
    });

    // onDecision called with approve
    expect(onDecision).toHaveBeenCalledWith({ decision: 'approve', card_id: 'card-abc123' });
  });

  it('reject calls onDecision without a PUT', async () => {
    const onDecision = vi.fn();
    vi.stubGlobal('fetch', makeFetchOk(PLAN_JSON));
    renderWithRouter(<PlanCard {...BASE_PROPS} onDecision={onDecision} />);

    await waitFor(() => screen.getByText('server/app.ts'));

    const rejectBtn = screen.getByRole('button', { name: /reject/i });
    await act(async () => {
      fireEvent.click(rejectBtn);
    });

    // No PUT was made
    const allCalls = (vi.mocked(globalThis.fetch) as ReturnType<typeof vi.fn>).mock.calls as Array<
      [string, RequestInit?]
    >;
    const putCall = allCalls.find(([, opts]) => (opts?.method ?? 'GET').toUpperCase() === 'PUT');
    expect(putCall).toBeUndefined();

    // onDecision called with reject
    expect(onDecision).toHaveBeenCalledWith({ decision: 'reject', card_id: 'card-abc123' });
  });

  it('renders prose fallback when plan.json fails schema validation', async () => {
    const invalidPlan = { schema_version: '1.0.0', summary: 'A plan', detail: 'Full prose here.' };
    // missing required 'files' field → fails schema check
    vi.stubGlobal('fetch', makeFetchOk(invalidPlan));
    renderWithRouter(<PlanCard {...BASE_PROPS} />);

    await waitFor(() => {
      // Falls back to prose rendering: shows the detail text
      expect(screen.getByTestId('plan-prose-fallback')).toBeInTheDocument();
    });
  });

  it('shows an error state when the artifact fetch fails', async () => {
    vi.stubGlobal('fetch', makeFetchFail(500));
    renderWithRouter(<PlanCard {...BASE_PROPS} />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });

  it.each(['create', 'modify', 'delete', 'rename'] as const)(
    'action=%s has a distinct badge',
    async (action) => {
      const planWithAction = {
        ...PLAN_JSON,
        files: [{ path: 'some/file.ts', action }],
      };
      vi.stubGlobal('fetch', makeFetchOk(planWithAction));
      renderWithRouter(<PlanCard {...BASE_PROPS} />);

      await waitFor(() => expect(screen.getByText(action)).toBeInTheDocument());
    },
  );
});
