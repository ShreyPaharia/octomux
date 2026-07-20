import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SchemaConfigForm, defaultsFromSchema } from './SchemaConfigForm';

const schema = {
  type: 'object',
  properties: {
    logCommand: { type: 'string', title: 'Log command', default: 'gh run list' },
    maxIterations: { type: 'integer', title: 'Max iterations', minimum: 1, default: 5 },
  },
};

describe('SchemaConfigForm', () => {
  it('extracts defaults from schema properties', () => {
    expect(defaultsFromSchema(schema)).toEqual({
      logCommand: 'gh run list',
      maxIterations: 5,
    });
  });

  it('renders fields from the schema and calls onChange', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SchemaConfigForm schema={schema} value={{ logCommand: 'gh run list' }} onChange={onChange} />);

    expect(screen.getByLabelText('Log command')).toBeInTheDocument();
    expect(screen.getByLabelText('Max iterations')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Log command'));
    await user.type(screen.getByLabelText('Log command'), 'flyctl logs');
    expect(onChange).toHaveBeenCalled();
  });
});
