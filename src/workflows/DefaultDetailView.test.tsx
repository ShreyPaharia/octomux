import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithRouter } from '@/test-helpers';
import { DefaultDetailView } from './DefaultDetailView';

describe('DefaultDetailView', () => {
  it('renders one row per schema property with the fetched item values', async () => {
    const getItem = vi.fn().mockResolvedValue({ area: 'server', risk: 'low' });
    renderWithRouter(
      <DefaultDetailView
        id="item-1"
        displayName="PR Extracts"
        outputSchema={{ properties: { area: { type: 'string' }, risk: { type: 'string' } } }}
        getItem={getItem}
      />,
    );

    expect(await screen.findByTestId('field-area')).toHaveTextContent('server');
    expect(screen.getByTestId('field-risk')).toHaveTextContent('low');
    expect(getItem).toHaveBeenCalledWith('item-1');
  });

  it('shows an error message when the fetch fails', async () => {
    const getItem = vi.fn().mockRejectedValue(new Error('not found'));
    renderWithRouter(
      <DefaultDetailView id="item-1" displayName="X" outputSchema={{}} getItem={getItem} />,
    );
    expect(await screen.findByText('not found')).toBeInTheDocument();
  });
});
