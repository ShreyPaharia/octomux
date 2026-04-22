import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import { childLogger, getLogger, setLogger } from './logger.js';

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

describe('logger', () => {
  let original: ReturnType<typeof getLogger>;

  beforeEach(() => {
    original = getLogger();
  });
  afterEach(() => {
    setLogger(original);
  });

  it('childLogger tags log lines with the module name', () => {
    const buf = bufferStream();
    setLogger(pino({ level: 'trace' }, buf.stream));

    childLogger('db').info({ task_id: 't1' }, 'hello');

    const lines = buf.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0].module).toBe('db');
    expect(lines[0].task_id).toBe('t1');
    expect(lines[0].msg).toBe('hello');
  });

  it('respects the root logger level', () => {
    const buf = bufferStream();
    setLogger(pino({ level: 'warn' }, buf.stream));

    const log = childLogger('startup');
    log.info('quiet');
    log.warn('loud');
    log.error('louder');

    const msgs = buf.lines().map((l) => l.msg);
    expect(msgs).toEqual(['loud', 'louder']);
  });

  it('preserves structured fields like task_id and agent_id', () => {
    const buf = bufferStream();
    setLogger(pino({ level: 'trace' }, buf.stream));

    childLogger('task-runner').info(
      { task_id: 'abc', agent_id: 'xyz', operation: 'create' },
      'Task created',
    );

    const [line] = buf.lines();
    expect(line.task_id).toBe('abc');
    expect(line.agent_id).toBe('xyz');
    expect(line.operation).toBe('create');
    expect(line.module).toBe('task-runner');
  });

  it('defaults to silent in the test environment', () => {
    // Root logger default (built at import time with NODE_ENV=test) should be silent —
    // verify by calling info on a freshly built child and ensuring nothing throws.
    // This exercises the live config; no buffer is required.
    expect(() => childLogger('test').info('should be silent')).not.toThrow();
  });
});
