import { describe, it, expect, beforeEach, afterEach } from '../bun-test.js';
import { askHumans, DEFAULT_ATTENTION_TIMEOUT_MS } from './index.js';
import { registerSurface, resetSurfaces } from '../surfaces/registry.js';
import type { SurfaceDefinition, SurfacePrompt } from '@octomux/plugin-api';

function promptSurface(
  kind: string,
  prompt: (ask: SurfacePrompt) => Promise<string | undefined>,
): SurfaceDefinition {
  return { kind, renderers: ['json'], prompt };
}

function readOnlySurface(kind: string): SurfaceDefinition {
  return { kind, renderers: ['json'] };
}

describe('attention/askHumans', () => {
  beforeEach(() => {
    resetSurfaces();
  });

  afterEach(() => {
    resetSurfaces();
  });

  it('DEFAULT_ATTENTION_TIMEOUT_MS is 5 minutes', () => {
    expect(DEFAULT_ATTENTION_TIMEOUT_MS).toBe(300_000);
  });

  it('fans out to every prompt-capable surface and skips read-only ones', async () => {
    const seen: string[] = [];
    registerSurface(
      promptSurface('demo:a', async () => {
        seen.push('demo:a');
        return 'yes';
      }),
    );
    registerSurface(readOnlySurface('web'));

    const result = await askHumans({ question: 'ship it?' });

    expect(seen).toEqual(['demo:a']);
    expect(result).toEqual({ status: 'answered', answer: 'yes', surface: 'demo:a' });
  });

  it('first answer wins and losers get their signal aborted', async () => {
    let loserSignal: AbortSignal | undefined;
    let releaseLoser!: () => void;
    const loserWait = new Promise<void>((resolve) => {
      releaseLoser = resolve;
    });

    registerSurface(promptSurface('demo:fast', async () => 'fast-answer'));
    registerSurface(
      promptSurface('demo:slow', async (ask) => {
        loserSignal = ask.signal;
        await loserWait;
        return 'slow-answer';
      }),
    );

    const result = await askHumans({ question: 'q' });

    expect(result).toEqual({ status: 'answered', answer: 'fast-answer', surface: 'demo:fast' });
    expect(loserSignal?.aborted).toBe(true);
    releaseLoser();
  });

  it('a rejecting surface does not wedge the ask', async () => {
    registerSurface(
      promptSurface('demo:broken', async () => {
        throw new Error('boom');
      }),
    );
    registerSurface(promptSurface('demo:ok', async () => 'fine'));

    const result = await askHumans({ question: 'q' });

    expect(result).toEqual({ status: 'answered', answer: 'fine', surface: 'demo:ok' });
  });

  it('a surface that throws SYNCHRONOUSLY does not reject the ask', async () => {
    // Not the same path as the async rejection above: a sync throw escapes
    // before any promise exists, so it would take out `askHumans` itself
    // rather than landing in the per-surface catch.
    registerSurface({
      kind: 'demo:sync-throw',
      renderers: ['json'],
      prompt: () => {
        throw new Error('boom');
      },
    } as unknown as SurfaceDefinition);
    registerSurface(promptSurface('demo:ok', async () => 'fine'));

    const result = await askHumans({ question: 'q' });

    expect(result).toEqual({ status: 'answered', answer: 'fine', surface: 'demo:ok' });
  });

  it('all surfaces declining resolves unanswerable with defaultAnswer', async () => {
    registerSurface(promptSurface('demo:a', async () => undefined));
    registerSurface(promptSurface('demo:b', async () => undefined));

    const result = await askHumans({ question: 'q', defaultAnswer: 'hold' });

    expect(result).toEqual({ status: 'unanswerable', answer: 'hold' });
  });

  it('no prompt-capable surface resolves unanswerable without waiting', async () => {
    registerSurface(readOnlySurface('web'));

    const start = Date.now();
    const result = await askHumans({ question: 'q', defaultAnswer: 'hold', timeoutMs: 10_000 });
    const elapsed = Date.now() - start;

    expect(result).toEqual({ status: 'unanswerable', answer: 'hold' });
    expect(elapsed).toBeLessThan(1_000);
  });

  it('times out when nobody answers in time', async () => {
    registerSurface(promptSurface('demo:slow', () => new Promise<string | undefined>(() => {})));

    const result = await askHumans({ question: 'q', defaultAnswer: 'hold', timeoutMs: 20 });

    expect(result).toEqual({ status: 'timeout', answer: 'hold' });
  });
});
