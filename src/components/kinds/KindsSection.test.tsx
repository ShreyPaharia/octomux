import { describe, it, expect, vi, beforeEach } from '../../bun-test.js';

const { kindsApiProxy, kindsApiMock } = await vi.hoisted(async () => {
  const listKinds = vi.fn().mockResolvedValue({
    kinds: [
      {
        kind: 'prod-log-triage',
        displayName: 'Prod Log Triage',
        execution: 'task',
        source: 'builtin',
        prompt: 'Investigate the overnight logs.',
      },
      {
        kind: 'my-custom-kind',
        displayName: 'My Custom Kind',
        execution: 'session',
        source: 'home',
        prompt: 'Do the thing.',
        defaultCron: '0 9 * * *',
      },
    ],
  });
  const savePreset = vi.fn().mockResolvedValue({
    kind: 'prod-log-triage-custom',
    displayName: 'Prod Log Triage',
    execution: 'session',
    source: 'home',
  });
  const deletePreset = vi.fn().mockResolvedValue(undefined);
  const kindsApiMock = { listKinds, savePreset, deletePreset };
  return { kindsApiMock, kindsApiProxy: kindsApiMock };
});

vi.mock('@/lib/api/kindsApi', () => ({ kindsApi: kindsApiProxy }));

const { render, screen, waitFor, within } = await import('@testing-library/react');
const { default: userEvent } = await import('@testing-library/user-event');
const { KindsSection } = await import('./KindsSection');

function renderSection() {
  return render(<KindsSection scrollRef={() => {}} />);
}

describe('KindsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    kindsApiMock.listKinds.mockResolvedValue({
      kinds: [
        {
          kind: 'prod-log-triage',
          displayName: 'Prod Log Triage',
          execution: 'task',
          source: 'builtin',
          prompt: 'Investigate the overnight logs.',
        },
        {
          kind: 'my-custom-kind',
          displayName: 'My Custom Kind',
          execution: 'session',
          source: 'home',
          prompt: 'Do the thing.',
          defaultCron: '0 9 * * *',
        },
      ],
    });
  });

  it('lists presets with built-in/custom badges', async () => {
    renderSection();
    expect(await screen.findByTestId('kind-row-prod-log-triage')).toBeInTheDocument();
    expect(screen.getByTestId('kind-row-my-custom-kind')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('kind-row-prod-log-triage')).getByText('built-in'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('kind-row-my-custom-kind')).getByText('custom'),
    ).toBeInTheDocument();
  });

  it('built-in preset only offers "Copy to custom", not Edit or Delete', async () => {
    renderSection();
    const row = await screen.findByTestId('kind-row-prod-log-triage');
    expect(within(row).getByTestId('kind-edit-prod-log-triage')).toHaveTextContent(
      'Copy to custom',
    );
    expect(within(row).queryByTestId('kind-delete-prod-log-triage')).not.toBeInTheDocument();
  });

  it('home-tier preset offers Edit and Delete', async () => {
    renderSection();
    const row = await screen.findByTestId('kind-row-my-custom-kind');
    expect(within(row).getByTestId('kind-edit-my-custom-kind')).toHaveTextContent('Edit');
    expect(within(row).getByTestId('kind-delete-my-custom-kind')).toBeInTheDocument();
  });

  it('"Copy to custom" opens the editor pre-filled with a new kind id, and saves via PUT', async () => {
    const user = userEvent.setup();
    renderSection();

    const row = await screen.findByTestId('kind-row-prod-log-triage');
    await user.click(within(row).getByTestId('kind-edit-prod-log-triage'));

    const kindInput = await screen.findByTestId('kind-editor-id');
    expect(kindInput).toHaveValue('prod-log-triage-custom');
    expect(kindInput).not.toBeDisabled();

    await user.click(screen.getByTestId('kind-editor-save'));

    await waitFor(() =>
      expect(kindsApiMock.savePreset).toHaveBeenCalledWith(
        'prod-log-triage-custom',
        expect.objectContaining({
          kind: 'prod-log-triage-custom',
          execution: 'session',
        }),
      ),
    );
  });

  it('editing a home-tier preset locks the kind id field', async () => {
    const user = userEvent.setup();
    renderSection();

    const row = await screen.findByTestId('kind-row-my-custom-kind');
    await user.click(within(row).getByTestId('kind-edit-my-custom-kind'));

    const kindInput = await screen.findByTestId('kind-editor-id');
    expect(kindInput).toHaveValue('my-custom-kind');
    expect(kindInput).toBeDisabled();
  });

  it('deleting a home-tier preset calls DELETE and refreshes the list', async () => {
    const user = userEvent.setup();
    renderSection();

    const row = await screen.findByTestId('kind-row-my-custom-kind');
    await user.click(within(row).getByTestId('kind-delete-my-custom-kind'));

    await user.click(await screen.findByTestId('confirm-delete-kind-confirm'));

    await waitFor(() => expect(kindsApiMock.deletePreset).toHaveBeenCalledWith('my-custom-kind'));
  });

  it('rejects invalid JSON in the config schema textarea with an inline error', async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByText('+ New kind'));
    const configField = await screen.findByTestId('kind-editor-config');
    await user.click(configField);
    await user.paste('{ not valid json');
    await user.tab();

    const error = await screen.findByTestId('kind-editor-config-error');
    expect(error.textContent).toBeTruthy();
    expect(screen.getByTestId('kind-editor-save')).toBeDisabled();
  });

  it('New kind opens a blank, editable editor', async () => {
    const user = userEvent.setup();
    renderSection();

    await screen.findByTestId('kind-row-prod-log-triage');
    await user.click(screen.getByText('+ New kind'));

    const kindInput = await screen.findByTestId('kind-editor-id');
    expect(kindInput).toHaveValue('');
    expect(kindInput).not.toBeDisabled();
    expect(screen.getByTestId('kind-editor-save')).toBeDisabled();
  });

  it('import dialog parses pasted JSON and calls savePreset with its kind', async () => {
    const user = userEvent.setup();
    renderSection();

    await screen.findByTestId('kind-row-prod-log-triage');
    await user.click(screen.getByTestId('kind-import-open'));

    const textarea = await screen.findByTestId('kind-import-textarea');
    await user.click(textarea);
    await user.paste(
      JSON.stringify({ kind: 'imported-kind', displayName: 'Imported', execution: 'session' }),
    );
    await user.click(screen.getByTestId('kind-import-submit'));

    await waitFor(() =>
      expect(kindsApiMock.savePreset).toHaveBeenCalledWith(
        'imported-kind',
        expect.objectContaining({ kind: 'imported-kind' }),
      ),
    );
  });
});
