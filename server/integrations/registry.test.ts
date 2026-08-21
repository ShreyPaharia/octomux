import { describe, it, expect, afterEach } from '../bun-test.js';
import {
  registerProvider,
  unregisterProvider,
  getProvider,
  listProviders,
  resetProviders,
  freezeCoreProviders,
  CORE_PROVIDER_KINDS,
} from './registry.js';
import { getLogger, setLogger } from '../logger.js';
import pino from 'pino';
import type { IntegrationProvider } from './types.js';

function bufferStream() {
  const chunks: string[] = [];
  return {
    stream: { write: (chunk: string) => chunks.push(chunk) },
    lines: (): Array<Record<string, unknown>> =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

function withCapturedLogs(fn: () => void): Array<Record<string, unknown>> {
  const original = getLogger();
  const buf = bufferStream();
  setLogger(pino({ level: 'trace' }, buf.stream));
  try {
    fn();
  } finally {
    setLogger(original);
  }
  return buf.lines();
}

function fakeProvider(kind: string): IntegrationProvider {
  return {
    kind,
    displayName: kind,
    configSchema: { type: 'object' },
    events: [],
    validate: () =>
      ({ valid: true, errors: [] }) as unknown as ReturnType<IntegrationProvider['validate']>,
    handler: async () => {},
  };
}

describe('unregisterProvider', () => {
  afterEach(() => {
    resetProviders();
  });

  it('removes a plugin-registered provider', () => {
    resetProviders();
    registerProvider(fakeProvider('demo-plugin:changelog'));
    expect(getProvider('demo-plugin:changelog')).toBeDefined();
    expect(unregisterProvider('demo-plugin:changelog')).toBe(true);
    expect(getProvider('demo-plugin:changelog')).toBeUndefined();
    expect(listProviders().some((p) => p.kind === 'demo-plugin:changelog')).toBe(false);
  });

  it('returns false for a kind that was never registered', () => {
    resetProviders();
    expect(unregisterProvider('never-existed')).toBe(false);
  });

  it('refuses a core provider kind, even without a prior freeze', () => {
    resetProviders();
    registerProvider(fakeProvider('jira'));

    const lines = withCapturedLogs(() => {
      expect(unregisterProvider('jira')).toBe(false);
    });

    expect(getProvider('jira')).toBeDefined();
    const warnLine = lines.find((l) => l.msg === 'refusing to unregister core provider kind');
    expect(warnLine).toBeDefined();
    expect(warnLine!.kind).toBe('jira');
  });

  it('CORE_PROVIDER_KINDS names every reserved kind this guards', () => {
    expect(CORE_PROVIDER_KINDS).toEqual(['jira', 'linear', 'slack-gateway', 'telegram-gateway']);
  });
});

describe('registerProvider / freezeCoreProviders (regression coverage for the guard order)', () => {
  afterEach(() => {
    resetProviders();
  });

  it('freeze refuses even a never-registered core kind', () => {
    resetProviders();
    freezeCoreProviders();
    registerProvider(fakeProvider('jira'));
    expect(getProvider('jira')).toBeUndefined();
  });
});
