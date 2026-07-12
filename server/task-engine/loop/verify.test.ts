import { describe, it, expect } from 'vitest';
import { runVerify } from './verify.js';

describe('runVerify', () => {
  it('passes when the command exits 0', async () => {
    const result = await runVerify(process.cwd(), 'echo hello');
    expect(result.passed).toBe(true);
    expect(result.output).toContain('hello');
  });

  it('fails with captured output when the command exits non-zero', async () => {
    const result = await runVerify(process.cwd(), 'echo boom >&2; exit 1');
    expect(result.passed).toBe(false);
    expect(result.output).toContain('boom');
  });
});
