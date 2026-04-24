import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { OfflineBanner } from './OfflineBanner';

type StateCb = (connected: boolean) => void;
const subscribers = new Set<StateCb>();

vi.mock('@/lib/event-source', () => ({
  subscribeConnectionState: (cb: StateCb) => {
    subscribers.add(cb);
    cb(true);
    return () => subscribers.delete(cb);
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
  subscribers.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

function simulate(connected: boolean) {
  for (const cb of subscribers) cb(connected);
}

describe('OfflineBanner', () => {
  it('does not render when connected', () => {
    render(<OfflineBanner />);
    expect(screen.queryByTestId('global-offline-banner')).not.toBeInTheDocument();
  });

  it('renders after 10s of disconnect, hides on reconnect', () => {
    render(<OfflineBanner />);
    act(() => simulate(false));
    // Before 10s: not visible
    act(() => {
      vi.advanceTimersByTime(9_000);
    });
    expect(screen.queryByTestId('global-offline-banner')).not.toBeInTheDocument();
    // After 10s: visible
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByTestId('global-offline-banner')).toBeInTheDocument();
    // Reconnect hides it
    act(() => simulate(true));
    expect(screen.queryByTestId('global-offline-banner')).not.toBeInTheDocument();
  });
});
