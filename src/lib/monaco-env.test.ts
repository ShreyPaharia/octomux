import { beforeEach, describe, expect, it, vi } from 'vitest';

class FakeWorker {
  postMessage() {}
  terminate() {}
  addEventListener() {}
  removeEventListener() {}
}

vi.mock('monaco-editor/esm/vs/editor/editor.worker?worker', () => ({
  default: class {
    constructor() {
      return new FakeWorker() as unknown as Worker;
    }
  },
}));

beforeEach(() => {
  delete (self as { MonacoEnvironment?: unknown }).MonacoEnvironment;
  vi.resetModules();
});

describe('monaco-env', () => {
  it('registers self.MonacoEnvironment.getWorker on import', async () => {
    await import('./monaco-env');
    const env = (self as unknown as Window).MonacoEnvironment;
    expect(env).toBeDefined();
    expect(typeof env?.getWorker).toBe('function');
    const worker = env!.getWorker!('id', 'editorWorkerService');
    expect(worker).toBeInstanceOf(FakeWorker);
  });

  it('does not overwrite an existing MonacoEnvironment', async () => {
    const sentinel = { getWorker: () => new FakeWorker() as unknown as Worker };
    (self as unknown as Window).MonacoEnvironment = sentinel;
    await import('./monaco-env');
    expect((self as unknown as Window).MonacoEnvironment).toBe(sentinel);
  });
});
