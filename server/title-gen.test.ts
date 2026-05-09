/**
 * B5: Tests for server/title-gen.ts
 *
 * Covers: no-key fallback, SDK error fallback, success path, timeout fallback.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── SDK Mock Setup ──────────────────────────────────────────────────────────

const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: { create: mockCreate },
    })),
  };
});

// ─── Test helpers ────────────────────────────────────────────────────────────

const SAMPLE_PROMPT = 'Add an archive button to the task board so old tasks can be hidden';

function makeSuccessResponse(title: string, description: string) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ title, description }),
      },
    ],
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('generateTitleAndDescription (B5)', () => {
  const originalEnv = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore env
    if (originalEnv === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalEnv;
    }
  });

  it('falls back to first-line truncation when ANTHROPIC_API_KEY is not set', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    // Re-import to get fresh module state
    vi.resetModules();
    const { generateTitleAndDescription } = await import('./title-gen.js');

    const result = await generateTitleAndDescription(SAMPLE_PROMPT);
    expect(result.title).toBe(SAMPLE_PROMPT.slice(0, 80));
    expect(result.description).toBe(SAMPLE_PROMPT);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns generated title and description on success', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key-123';
    mockCreate.mockResolvedValueOnce(
      makeSuccessResponse('Add Archive Button', 'Add an archive button to hide old tasks.'),
    );

    vi.resetModules();
    const { generateTitleAndDescription } = await import('./title-gen.js');

    const result = await generateTitleAndDescription(SAMPLE_PROMPT);
    expect(result.title).toBe('Add Archive Button');
    expect(result.description).toBe('Add an archive button to hide old tasks.');
  });

  it('truncates title to 50 chars on success', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key-123';
    const longTitle = 'A'.repeat(100);
    mockCreate.mockResolvedValueOnce(makeSuccessResponse(longTitle, 'Description here.'));

    vi.resetModules();
    const { generateTitleAndDescription } = await import('./title-gen.js');

    const result = await generateTitleAndDescription(SAMPLE_PROMPT);
    expect(result.title.length).toBeLessThanOrEqual(50);
  });

  it('falls back when SDK throws an error', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key-123';
    mockCreate.mockRejectedValueOnce(new Error('API rate limit exceeded'));

    vi.resetModules();
    const { generateTitleAndDescription } = await import('./title-gen.js');

    const result = await generateTitleAndDescription(SAMPLE_PROMPT);
    // Fallback: first line of prompt, truncated to 80 chars
    expect(result.title).toBe(SAMPLE_PROMPT.slice(0, 80));
    expect(result.description).toBe(SAMPLE_PROMPT);
  });

  it('falls back when SDK returns invalid JSON', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key-123';
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'not valid json' }],
    });

    vi.resetModules();
    const { generateTitleAndDescription } = await import('./title-gen.js');

    const result = await generateTitleAndDescription(SAMPLE_PROMPT);
    expect(result.title).toBe(SAMPLE_PROMPT.slice(0, 80));
  });

  it('falls back when AbortError is thrown (simulates timeout)', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key-123';

    // Simulate what happens when AbortController fires: rejection with AbortError
    mockCreate.mockRejectedValueOnce(new DOMException('The operation was aborted.', 'AbortError'));

    vi.resetModules();
    const { generateTitleAndDescription } = await import('./title-gen.js');

    const result = await generateTitleAndDescription(SAMPLE_PROMPT);
    // Should fall back gracefully on abort
    expect(result.title).toBe(SAMPLE_PROMPT.slice(0, 80));
    expect(result.description).toBe(SAMPLE_PROMPT);
  });

  it('uses fallback "Untitled task" when prompt is empty', async () => {
    delete process.env.ANTHROPIC_API_KEY;

    vi.resetModules();
    const { generateTitleAndDescription } = await import('./title-gen.js');

    const result = await generateTitleAndDescription('');
    expect(result.title).toBe('Untitled task');
  });
});
