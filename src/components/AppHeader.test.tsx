import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { AppHeader } from './AppHeader';
import { renderWithRouter } from '../test-helpers';

// Mock the orchestrator context
vi.mock('@/lib/orchestrator-context', () => ({
  useOrchestratorContext: () => ({
    isOpen: false,
    running: false,
    loading: false,
    open: vi.fn(),
    close: vi.fn(),
    toggle: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/lib/api', () => ({
  api: new Proxy({}, { get: () => vi.fn().mockResolvedValue({}) }),
}));

describe('AppHeader', () => {
  it('renders branding', () => {
    renderWithRouter(<AppHeader />);
    expect(screen.getByText('octomux')).toBeInTheDocument();
    expect(screen.getByAltText('octomux')).toBeInTheDocument();
  });

  it('renders orchestrator toggle', () => {
    renderWithRouter(<AppHeader />);
    expect(screen.getByTitle('Toggle orchestrator')).toBeInTheDocument();
  });

  it('renders new task button', () => {
    renderWithRouter(<AppHeader />);
    expect(screen.getAllByText('New Task').length).toBeGreaterThan(0);
  });
});
