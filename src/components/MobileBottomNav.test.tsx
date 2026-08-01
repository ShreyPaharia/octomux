import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { MobileBottomNav } from './MobileBottomNav';
import { renderWithRouter } from '../test-helpers';

describe('MobileBottomNav', () => {
  it('renders primary nav links', () => {
    renderWithRouter(<MobileBottomNav />, { route: '/' });
    expect(screen.getByTestId('mobile-bottom-nav')).toBeInTheDocument();
    expect(screen.getByLabelText('Home')).toBeInTheDocument();
    expect(screen.getByLabelText('Tasks')).toBeInTheDocument();
    expect(screen.getByLabelText('Runs')).toBeInTheDocument();
    expect(screen.getByLabelText('Reviews')).toBeInTheDocument();
    expect(screen.getByLabelText('Settings')).toBeInTheDocument();
  });

  it('marks Runs active on /runs', () => {
    renderWithRouter(<MobileBottomNav />, { route: '/runs' });
    expect(screen.getByLabelText('Runs')).toHaveAttribute('aria-current', 'page');
  });

  it('marks Tasks active on task detail routes', () => {
    renderWithRouter(<MobileBottomNav />, { route: '/tasks/abc123' });
    expect(screen.getByLabelText('Tasks')).toHaveAttribute('aria-current', 'page');
  });
});
