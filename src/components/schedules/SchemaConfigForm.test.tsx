import { describe, it, expect, vi, beforeEach } from '../../bun-test.js';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { listSecretsMock } = vi.hoisted(() => ({ listSecretsMock: vi.fn() }));
vi.mock('@/lib/api/secretsApi', () => ({
  secretsApi: { listSecrets: listSecretsMock },
}));

const { SchemaConfigForm, defaultsFromSchema } = await import('./SchemaConfigForm');

const schema = {
  type: 'object',
  properties: {
    logCommand: { type: 'string', title: 'Log command', default: 'gh run list' },
    maxIterations: { type: 'integer', title: 'Max iterations', minimum: 1, default: 5 },
  },
};

beforeEach(() => {
  listSecretsMock.mockReset();
  listSecretsMock.mockResolvedValue({ secrets: [] });
});

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

  describe('secretRef', () => {
    const secretRefSchema = {
      type: 'object',
      properties: {
        apiToken: { type: 'string', title: 'API token', secretRef: true },
      },
    };

    it('renders a select, not a text input', async () => {
      listSecretsMock.mockResolvedValue({
        secrets: [{ name: 'MY_TOKEN', description: null, created_at: '', updated_at: '' }],
      });
      render(<SchemaConfigForm schema={secretRefSchema} value={{}} onChange={vi.fn()} />);

      const field = screen.getByLabelText('API token');
      expect(field.tagName.toLowerCase()).toBe('select');
      await waitFor(() => expect((field as HTMLSelectElement).options.length).toBe(2));
    });

    it('lists the secret names returned by the API as options, plus a blank first option', async () => {
      listSecretsMock.mockResolvedValue({
        secrets: [
          { name: 'MY_TOKEN', description: null, created_at: '', updated_at: '' },
          { name: 'OTHER_TOKEN', description: null, created_at: '', updated_at: '' },
        ],
      });
      render(<SchemaConfigForm schema={secretRefSchema} value={{}} onChange={vi.fn()} />);

      const field = (await screen.findByLabelText('API token')) as HTMLSelectElement;
      await waitFor(() => {
        const options = Array.from(field.options).map((o) => o.value);
        expect(options).toEqual(['', 'MY_TOKEN', 'OTHER_TOKEN']);
      });
    });

    it('selecting a name calls onChange with the wrapped ${secret:NAME} form', async () => {
      listSecretsMock.mockResolvedValue({
        secrets: [{ name: 'MY_TOKEN', description: null, created_at: '', updated_at: '' }],
      });
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<SchemaConfigForm schema={secretRefSchema} value={{}} onChange={onChange} />);

      const field = await screen.findByLabelText('API token');
      await waitFor(() => {
        expect((field as HTMLSelectElement).options.length).toBe(2);
      });
      await user.selectOptions(field, 'MY_TOKEN');
      expect(onChange).toHaveBeenCalledWith({ apiToken: '${secret:MY_TOKEN}' });
    });

    it('shows a stored ${secret:FOO} value as the selected option', async () => {
      listSecretsMock.mockResolvedValue({
        secrets: [
          { name: 'FOO', description: null, created_at: '', updated_at: '' },
          { name: 'BAR', description: null, created_at: '', updated_at: '' },
        ],
      });
      render(
        <SchemaConfigForm
          schema={secretRefSchema}
          value={{ apiToken: '${secret:FOO}' }}
          onChange={vi.fn()}
        />,
      );

      const field = (await screen.findByLabelText('API token')) as HTMLSelectElement;
      await waitFor(() => expect(field.value).toBe('FOO'));
    });

    it('selects nothing when the stored value is not a ${secret:...} wrapper', async () => {
      listSecretsMock.mockResolvedValue({
        secrets: [{ name: 'FOO', description: null, created_at: '', updated_at: '' }],
      });
      render(
        <SchemaConfigForm
          schema={secretRefSchema}
          value={{ apiToken: 'plain-text-value' }}
          onChange={vi.fn()}
        />,
      );

      const field = (await screen.findByLabelText('API token')) as HTMLSelectElement;
      await waitFor(() => expect(listSecretsMock).toHaveBeenCalled());
      expect(field.value).toBe('');
    });

    it('renders a disabled select with a hint option when there are no secrets', async () => {
      listSecretsMock.mockResolvedValue({ secrets: [] });
      render(<SchemaConfigForm schema={secretRefSchema} value={{}} onChange={vi.fn()} />);

      const field = (await screen.findByLabelText('API token')) as HTMLSelectElement;
      await waitFor(() => expect(listSecretsMock).toHaveBeenCalled());
      expect(field.disabled).toBe(true);
      expect(field.options.length).toBe(1);
      expect(field.options[0].textContent).toContain('octomux secrets set');
    });

    it('still renders the description paragraph', async () => {
      const schemaWithDescription = {
        type: 'object',
        properties: {
          apiToken: {
            type: 'string',
            title: 'API token',
            secretRef: true,
            description: 'Used to authenticate outbound calls',
          },
        },
      };
      render(<SchemaConfigForm schema={schemaWithDescription} value={{}} onChange={vi.fn()} />);

      expect(screen.getByText('Used to authenticate outbound calls')).toBeInTheDocument();
      await waitFor(() => expect(listSecretsMock).toHaveBeenCalled());
    });
  });
});
