import { describe, it, expect } from 'vitest';
import { resolveStoredPrompt } from './schedulePrompt';

describe('resolveStoredPrompt', () => {
  const defaultPrompt = 'Default skill prompt';

  it('stores null when prompt matches the default', () => {
    expect(resolveStoredPrompt('Default skill prompt', defaultPrompt)).toBeNull();
    expect(resolveStoredPrompt('  Default skill prompt  ', defaultPrompt)).toBeNull();
  });

  it('stores null when prompt is empty', () => {
    expect(resolveStoredPrompt('', defaultPrompt)).toBeNull();
    expect(resolveStoredPrompt('   ', defaultPrompt)).toBeNull();
  });

  it('stores edited text when prompt differs from default', () => {
    expect(resolveStoredPrompt('Custom prompt', defaultPrompt)).toBe('Custom prompt');
  });
});
