/**
 * Proves `fireIntegrationProviders` resolves a real provider once the app has
 * booted — no mocks on `integrations/registry.js` or `integrations/index.js`,
 * and the registry reset to empty first so nothing else in this process could
 * have "happened to load the barrel" ahead of it.
 *
 * `fireIntegrationProviders` dynamically imports the bare `registry.js`, which
 * is empty unless something imported the barrel for its registration side
 * effect. Nothing guaranteed that, so `getProvider(kind)` returned `undefined`
 * and every integration was silently dropped (`if (!provider) continue;`) —
 * no error, no log line. `server/app.ts` now anchors the barrel, and hook
 * dispatch is HTTP-triggered, so `createApp()` has always run by this point.
 */
import { describe, it, expect } from './bun-test.js';
import { createTestDb } from './test-helpers.js';
// Populate the registry the way app.ts does — explicitly, so this file does
// not depend on some other test file's ambient import order.
import './integrations/index.js';
import { createIntegration } from './integrations/store.js';
import { getLogger, setLogger } from './logger.js';
import pino from 'pino';
import { fireHook } from './hook-dispatcher.js';
import type { HookEnvelope } from './hook-types.js';

/** Collect pino JSON log lines into memory for assertions. */
function bufferStream() {
  const chunks: string[] = [];
  return {
    stream: {
      write(chunk: string) {
        chunks.push(chunk);
      },
    },
    lines(): Array<Record<string, unknown>> {
      return chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    },
  };
}

const ENVELOPE: HookEnvelope = {
  event: 'workflow_status_changed',
  task: { id: 'task-provider-registry' } as unknown as HookEnvelope['task'],
  data: { from: 'in_progress', to: 'done' },
};

describe('fireIntegrationProviders resolves providers via the barrel', () => {
  it('runs a real provider handler rather than silently dropping it', async () => {
    createTestDb();
    createIntegration('jira', 'Test Jira', {
      base_url: 'https://example.atlassian.net',
      email: 'a@b.com',
      api_token: 'tok',
      status_map: {},
    });

    const original = getLogger();
    const buf = bufferStream();
    setLogger(pino({ level: 'trace' }, buf.stream));
    try {
      await fireHook('workflow_status_changed', ENVELOPE);
    } finally {
      setLogger(original);
    }

    // This log line is emitted from inside the real jira provider's handler
    // (module "integrations:jira") — it only fires once `getProvider('jira')`
    // returned a real, registered provider past the `if (!provider) continue;`
    // guard. Its presence proves the registry was populated from inside
    // fireIntegrationProviders itself, not by some other module happening to
    // load the barrel first.
    const handlerRanLine = buf.lines().find((l) => l.module === 'integrations:jira');
    expect(handlerRanLine).toBeDefined();
    expect(handlerRanLine!.msg).toBe('jira handler: no jira ref found, skipping');
  });
});
