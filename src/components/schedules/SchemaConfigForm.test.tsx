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
    render(
      <SchemaConfigForm
        schema={schema}
        value={{ logCommand: 'gh run list' }}
        onChange={onChange}
      />,
    );

    expect(screen.getByLabelText('Log command')).toBeInTheDocument();
    expect(screen.getByLabelText('Max iterations')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Log command'));
    await user.type(screen.getByLabelText('Log command'), 'flyctl logs');
    expect(onChange).toHaveBeenCalled();
  });

  describe('format: single-line', () => {
    it('renders a string property with format single-line as Input (not Textarea)', () => {
      const singleLineSchema = {
        type: 'object',
        properties: {
          baseBranch: {
            type: 'string',
            title: 'Base branch',
            default: 'main',
            format: 'single-line',
          },
        },
      };
      render(
        <SchemaConfigForm
          schema={singleLineSchema}
          value={{ baseBranch: 'main' }}
          onChange={vi.fn()}
        />,
      );

      const field = screen.getByLabelText('Base branch');
      expect(field.tagName.toLowerCase()).toBe('input');
    });

    it('renders a string property without format as Textarea', () => {
      const multiLineSchema = {
        type: 'object',
        properties: {
          description: { type: 'string', title: 'Description', default: '' },
        },
      };
      render(
        <SchemaConfigForm
          schema={multiLineSchema}
          value={{ description: '' }}
          onChange={vi.fn()}
        />,
      );

      const field = screen.getByLabelText('Description');
      expect(field.tagName.toLowerCase()).toBe('textarea');
    });

    it('backward compat: logCommand without format renders as Textarea', () => {
      render(
        <SchemaConfigForm
          schema={schema}
          value={{ logCommand: 'gh run list' }}
          onChange={vi.fn()}
        />,
      );

      const field = screen.getByLabelText('Log command');
      expect(field.tagName.toLowerCase()).toBe('textarea');
    });

    it('calls onChange when single-line input changes', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      const singleLineSchema = {
        type: 'object',
        properties: {
          branchPrefix: {
            type: 'string',
            title: 'Branch prefix',
            default: 'doc-drift',
            format: 'single-line',
          },
        },
      };
      render(
        <SchemaConfigForm
          schema={singleLineSchema}
          value={{ branchPrefix: 'doc-drift' }}
          onChange={onChange}
        />,
      );

      const field = screen.getByLabelText('Branch prefix');
      await user.clear(field);
      await user.type(field, 'my-prefix');
      expect(onChange).toHaveBeenCalled();
    });
  });
});
