import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithRouter } from '@/test-helpers';
import { registerWorkflowUI } from './registry';
import WorkflowDetailRoute from './WorkflowDetailRoute';

function FakeIcon() {
  return <svg />;
}

describe('WorkflowDetailRoute', () => {
  it('renders a registered custom DetailView, passed the route id', async () => {
    function FakeDetailView({ id }: { id: string }) {
      return <div data-testid="fake-detail">{id}</div>;
    }
    registerWorkflowUI('fake-artifact', {
      navLabel: 'Fake Artifact',
      icon: FakeIcon,
      DetailView: FakeDetailView,
    });
    renderWithRouter(<WorkflowDetailRoute />, {
      route: '/w/fake-artifact/item-42',
      path: '/w/:kind/:id',
    });
    expect(await screen.findByTestId('fake-detail')).toHaveTextContent('item-42');
  });

  it('falls back to DefaultDetailView when no DetailView is registered', async () => {
    const getItem = vi.fn().mockResolvedValue({ area: 'x' });
    registerWorkflowUI('fake-schema-only', {
      navLabel: 'Fake Schema Only',
      icon: FakeIcon,
      getItem,
      outputSchema: { properties: { area: { type: 'string' } } },
    });
    renderWithRouter(<WorkflowDetailRoute />, {
      route: '/w/fake-schema-only/item-1',
      path: '/w/:kind/:id',
    });
    expect(await screen.findByTestId('default-detail-view')).toBeInTheDocument();
    expect(await screen.findByTestId('field-area')).toHaveTextContent('x');
  });
});
