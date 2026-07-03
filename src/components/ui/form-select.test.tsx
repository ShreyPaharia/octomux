import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FormSelect } from './form-select';

describe('FormSelect', () => {
  it('renders sm size classes by default', () => {
    render(
      <FormSelect data-testid="select">
        <option value="a">A</option>
      </FormSelect>,
    );
    const select = screen.getByTestId('select');
    expect(select.className).toContain('px-3');
    expect(select.className).toContain('py-1');
    expect(select.className).toContain('text-xs');
    expect(select.className).toContain('focus-ring');
  });

  it('renders md size classes', () => {
    render(
      <FormSelect data-testid="select" fieldSize="md">
        <option value="a">A</option>
      </FormSelect>,
    );
    expect(screen.getByTestId('select').className).toContain('py-2');
    expect(screen.getByTestId('select').className).toContain('text-sm');
  });
});
