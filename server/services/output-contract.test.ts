import { describe, it, expect } from 'vitest';
import { validateAgainstSchema } from './output-contract.js';

const SCHEMA = {
  type: 'object',
  required: ['area', 'risk'],
  properties: {
    area: { type: 'string', minLength: 1 },
    risk: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  additionalProperties: false,
} as const;

describe('validateAgainstSchema', () => {
  it('accepts a payload matching the schema', () => {
    const result = validateAgainstSchema('test-schema', SCHEMA, { area: 'server', risk: 'low' });
    expect(result).toEqual({ valid: true });
  });

  it('rejects a payload missing a required field', () => {
    const result = validateAgainstSchema('test-schema', SCHEMA, { area: 'server' });
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]).toMatch(/risk/);
  });

  it('rejects a payload with an out-of-enum value', () => {
    const result = validateAgainstSchema('test-schema', SCHEMA, {
      area: 'server',
      risk: 'extreme',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects additional properties not in the schema', () => {
    const result = validateAgainstSchema('test-schema', SCHEMA, {
      area: 'server',
      risk: 'low',
      extra: true,
    });
    expect(result.valid).toBe(false);
  });

  it('reuses a compiled validator for the same schema key', () => {
    const first = validateAgainstSchema('test-schema', SCHEMA, { area: 'a', risk: 'low' });
    const second = validateAgainstSchema('test-schema', SCHEMA, { area: 'b', risk: 'high' });
    expect(first.valid).toBe(true);
    expect(second.valid).toBe(true);
  });
});
