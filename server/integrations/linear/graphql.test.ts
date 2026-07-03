import { describe, it, expect, vi, beforeEach } from 'vitest';

const { LinearClientMock, MockLinearError } = vi.hoisted(() => {
  class MockLinearError extends Error {
    type?: string;
    errors?: Array<{ type?: string; message: string }>;
    status?: number;
    constructor(_raw?: unknown, errors?: Array<{ type?: string; message: string }>, type?: string) {
      super(errors?.[0]?.message ?? 'Linear error');
      this.name = 'LinearError';
      this.errors = errors;
      this.type = type;
    }
  }
  return {
    LinearClientMock: vi.fn(),
    MockLinearError,
  };
});

vi.mock('@linear/sdk', () => ({
  LinearClient: LinearClientMock,
  LinearError: MockLinearError,
  LinearErrorType: {
    AuthenticationError: 'AuthenticationError',
    Unknown: 'Unknown',
  },
}));

import { createLinearClient, invokeLinear, LinearApiError, toLinearApiError } from './graphql.js';

describe('createLinearClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    LinearClientMock.mockImplementation(function (this: unknown, opts: { apiKey?: string }) {
      return { apiKey: opts.apiKey };
    });
  });

  it('instantiates LinearClient with the bare api key', () => {
    const client = createLinearClient('lin_api_xyz');
    expect(LinearClientMock).toHaveBeenCalledWith({ apiKey: 'lin_api_xyz' });
    expect(client).toEqual({ apiKey: 'lin_api_xyz' });
  });
});

describe('toLinearApiError', () => {
  it('passes through LinearApiError', () => {
    const err = new LinearApiError('already wrapped', 'CODE');
    expect(toLinearApiError(err)).toBe(err);
  });

  it('wraps SDK LinearError with message and code', () => {
    const sdkErr = new MockLinearError(
      undefined,
      [{ message: 'Authentication failed', type: 'AuthenticationError' }],
      'AuthenticationError',
    );
    const wrapped = toLinearApiError(sdkErr);
    expect(wrapped).toBeInstanceOf(LinearApiError);
    expect(wrapped.message).toMatch(/Authentication failed/);
    expect(wrapped.code).toBe('AuthenticationError');
  });

  it('appends HTTP status when missing from SDK error message', () => {
    const sdkErr = new MockLinearError(undefined, [{ message: 'Server error', type: 'Unknown' }]);
    sdkErr.status = 500;
    const wrapped = toLinearApiError(sdkErr);
    expect(wrapped.message).toMatch(/500/);
  });
});

describe('invokeLinear', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    LinearClientMock.mockImplementation(function (this: unknown, opts: { apiKey?: string }) {
      return { apiKey: opts.apiKey };
    });
  });

  it('returns the callback result on success', async () => {
    const result = await invokeLinear('key', async (client) => {
      expect(client).toEqual({ apiKey: 'key' });
      return { ok: true };
    });
    expect(result).toEqual({ ok: true });
  });

  it('throws LinearApiError when the SDK raises LinearError', async () => {
    LinearClientMock.mockImplementation(() => ({
      get viewer() {
        return Promise.reject(
          new MockLinearError(
            undefined,
            [{ message: 'Authentication failed', type: 'AuthenticationError' }],
            'AuthenticationError',
          ),
        );
      },
    }));

    await expect(invokeLinear('bad', (c) => c.viewer)).rejects.toThrow(LinearApiError);
    await expect(invokeLinear('bad', (c) => c.viewer)).rejects.toThrow(/Authentication failed/);
  });
});
