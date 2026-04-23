import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import HomePage from './HomePage';
import { renderWithRouter } from '../test-helpers';

describe('HomePage', () => {
  it('renders welcome heading', () => {
    renderWithRouter(<HomePage />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/welcome back/i);
  });

  it('renders the coming-soon subtext', () => {
    renderWithRouter(<HomePage />);
    expect(screen.getByText(/composer and sessions inbox coming soon/i)).toBeInTheDocument();
  });
});
