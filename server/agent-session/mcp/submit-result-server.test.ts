import { describe, it, expect, vi } from 'vitest';
import {
  handleSubmitResultCall,
  buildToolDefinition,
  createSubmitResultServer,
} from './submit-result-server.js';

const SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    score: { type: 'number' },
  },
  required: ['reply'],
  additionalProperties: false,
} as const;

const TOOL_NAME = 'submit_result';

describe('handleSubmitResultCall', () => {
  it('valid args: calls onResult and returns isError:false', async () => {
    const captured: unknown[] = [];
    const onResult = (r: unknown) => {
      captured.push(r);
    };

    const result = await handleSubmitResultCall(
      SCHEMA,
      { reply: 'hi', score: 5 },
      TOOL_NAME,
      onResult,
    );

    expect(result.isError).toBe(false);
    expect(result.text).toBe('Result accepted.');
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({ reply: 'hi', score: 5 });
  });

  it('invalid type (reply is number): isError:true, onResult NOT called', async () => {
    const onResult = vi.fn();

    const result = await handleSubmitResultCall(SCHEMA, { reply: 123 }, TOOL_NAME, onResult);

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/invalid arguments/i);
    expect(onResult).not.toHaveBeenCalled();
  });

  it('missing required field (no reply): isError:true, onResult NOT called', async () => {
    const onResult = vi.fn();

    const result = await handleSubmitResultCall(SCHEMA, { score: 5 }, TOOL_NAME, onResult);

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/invalid arguments/i);
    expect(onResult).not.toHaveBeenCalled();
  });
});

describe('buildToolDefinition', () => {
  it('returns name, description, and raw inputSchema', () => {
    const def = buildToolDefinition(SCHEMA, TOOL_NAME, 'A description');

    expect(def.name).toBe(TOOL_NAME);
    expect(def.inputSchema).toBe(SCHEMA);
  });
});

describe('createSubmitResultServer', () => {
  it('returns a Server instance without throwing', () => {
    const onResult = vi.fn();
    expect(() => createSubmitResultServer({ schema: SCHEMA, onResult })).not.toThrow();
  });
});
