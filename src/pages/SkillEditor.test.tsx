import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SkillEditor from './SkillEditor';
import { renderWithRouter, mockApi } from '../test-helpers';

const apiMock = mockApi({
  getSkill: vi.fn().mockResolvedValue({ name: 'test-skill', content: '# Test Skill' }),
  updateSkill: vi.fn().mockResolvedValue({ name: 'test-skill', content: 'Updated' }),
});

vi.mock('@/lib/api', () => ({
  api: new Proxy(
    {},
    {
      get: (_target, prop: string) => apiMock[prop as keyof typeof apiMock],
    },
  ),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe('SkillEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getSkill.mockResolvedValue({ name: 'test-skill', content: '# Test Skill' });
    apiMock.updateSkill.mockResolvedValue({ name: 'test-skill', content: 'Updated' });
  });

  const renderEditor = () =>
    renderWithRouter(<SkillEditor />, { route: '/skills/test-skill', path: '/skills/:name' });

  it('renders skill content in textarea', async () => {
    renderEditor();
    await waitFor(() => {
      const textarea = screen.getByRole('textbox');
      expect(textarea).toHaveValue('# Test Skill');
    });
  });

  it('shows skill name in header', async () => {
    renderEditor();
    await waitFor(() => {
      expect(screen.getByText('test-skill')).toBeInTheDocument();
    });
  });

  it('save button is disabled when content unchanged', async () => {
    renderEditor();
    await waitFor(() => {
      expect(screen.getByRole('textbox')).toHaveValue('# Test Skill');
    });
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  });

  it('save button enables when content changes', async () => {
    const user = userEvent.setup();
    renderEditor();
    await waitFor(() => {
      expect(screen.getByRole('textbox')).toHaveValue('# Test Skill');
    });
    await user.click(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), ' extra');
    expect(screen.getByRole('button', { name: /save/i })).not.toBeDisabled();
  });

  it('shows error state when skill not found', async () => {
    apiMock.getSkill.mockRejectedValue(new Error('Skill not found'));
    renderEditor();
    await waitFor(() => {
      expect(screen.getByText('Skill not found')).toBeInTheDocument();
    });
  });

  it('shows unsaved indicator when content changes', async () => {
    const user = userEvent.setup();
    renderEditor();
    await waitFor(() => {
      expect(screen.getByRole('textbox')).toHaveValue('# Test Skill');
    });
    await user.click(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), ' changed');
    expect(screen.getByText('unsaved')).toBeInTheDocument();
  });
});
