import { describe, it, expect, afterEach } from 'vitest';
import { postPullRequestReview } from './github-client.js';

const SAMPLE_INPUT = {
  owner: 'octomux',
  repo: 'demo',
  pull_number: 42,
  commit_id: 'abc123',
  body: 'LGTM',
  event: 'COMMENT' as const,
  comments: [],
};

describe('postPullRequestReview — test stub hatch', () => {
  afterEach(() => {
    delete process.env.OCTOMUX_GH_STUB_RESPONSE;
  });

  it('returns parsed JSON from OCTOMUX_GH_STUB_RESPONSE when NODE_ENV=test', async () => {
    const stubPayload = {
      id: 99999,
      html_url: 'https://example.invalid/r/99999',
      comments: [
        { id: 1, path: 'a.ts', line: 5 },
        { id: 2, path: 'b.ts', line: 10 },
      ],
    };
    process.env.OCTOMUX_GH_STUB_RESPONSE = JSON.stringify(stubPayload);

    // NODE_ENV is already 'test' in vitest (set via vitest.config.ts)
    const result = await postPullRequestReview(SAMPLE_INPUT);
    expect(result.id).toBe(99999);
    expect(result.html_url).toBe('https://example.invalid/r/99999');
  });

  it('does not return stub data when OCTOMUX_GH_STUB_RESPONSE is absent', async () => {
    // OCTOMUX_GH_STUB_RESPONSE is unset and NODE_ENV=test → the real `gh` path
    // is taken. We just verify the stub branch did not fire (i.e. the function
    // rejects because `gh` is not going to successfully talk to GitHub in test).
    // The promise rejects — confirm it doesn't resolve with stub-like data.
    const result = postPullRequestReview(SAMPLE_INPUT);
    await expect(result).rejects.toThrow();
  });
});
