import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithRouter } from '@/test-helpers';
import { registerWorkflowUI } from './registry';
import WorkflowListRoute from './WorkflowListRoute';

function FakeIcon() {
  return <svg />;
}
function FakeListView() {
  return <div data-testid="fake-list">fake list</div>;
}

describe('WorkflowListRoute', () => {
  it("renders the registered kind's ListView", async () => {
    registerWorkflowUI('fake-feed', {
      navLabel: 'Fake Feed',
      icon: FakeIcon,
      ListView: FakeListView,
    });
    renderWithRouter(<WorkflowListRoute />, { route: '/w/fake-feed', path: '/w/:kind' });
    expect(await screen.findByTestId('fake-list')).toBeInTheDocument();
  });

  it('shows a fallback message for an unregistered kind', async () => {
    renderWithRouter(<WorkflowListRoute />, { route: '/w/never-registered', path: '/w/:kind' });
    expect(await screen.findByText(/Unknown workflow kind/)).toBeInTheDocument();
  });
});
