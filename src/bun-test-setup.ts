/**
 * Preload for `bun test ./src` — the browser environment the frontend suite needs.
 *
 * bun has no `environment: 'jsdom'` switch like vitest, so happy-dom is
 * registered as real globals here and this file is passed via --preload.
 * It is NOT loaded for the server suite, which must keep running without a DOM.
 */

import { plugin } from 'bun';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { expect, afterEach } from 'bun:test';
import * as matchers from '@testing-library/jest-dom/matchers';

// Vite's `?worker` import suffix has no meaning outside a Vite build; vitest
// resolved it through Vite's pipeline. Stub it with the same shape Vite emits —
// a default-exported Worker constructor — so monaco's env module can load.
plugin({
  name: 'vite-worker-stub',
  setup(build) {
    build.onResolve({ filter: /\?worker$/ }, (args) => ({
      path: args.path,
      namespace: 'vite-worker',
    }));
    build.onLoad({ filter: /.*/, namespace: 'vite-worker' }, () => ({
      contents: 'export default class ViteWorkerStub {};',
      loader: 'js',
    }));
  },
});

// Vite injects import.meta.env.MODE; vitest set it to 'test'. bun maps
// import.meta.env onto process.env, so set it there for code that branches on it.
process.env.MODE ??= 'test';

// jsdom defaulted to http://localhost/; happy-dom defaults to about:blank, an
// opaque origin where history.replaceState throws — silently breaking any
// component that syncs state into the URL.
GlobalRegistrator.register({ url: 'http://localhost/' });
expect.extend(matchers as unknown as Parameters<typeof expect.extend>[0]);

// React Testing Library auto-registers its cleanup against vitest/jest globals.
// Under bun those don't exist, so mounted trees (and their timers, observers and
// event listeners) survive between tests and keep the process alive.
const { cleanup } = await import('@testing-library/react');
afterEach(cleanup);

// happy-dom doesn't implement matchMedia — stub it for components that use media queries
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// happy-dom doesn't implement IntersectionObserver — stub it with a default that
// asynchronously reports every observed element as intersecting=true so any
// component that lazy-mounts on visibility ends up rendering its content in
// tests. Individual tests can replace `globalThis.IntersectionObserver` with
// a controllable mock via `vi.stubGlobal` or by re-assigning the global.
class TestIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null = null;
  readonly rootMargin: string = '';
  readonly thresholds: readonly number[] = [];
  private cb: IntersectionObserverCallback;
  private targets = new Set<Element>();
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
  }
  observe(target: Element): void {
    this.targets.add(target);
    queueMicrotask(() => {
      if (!this.targets.has(target)) return;
      const entry: IntersectionObserverEntry = {
        target,
        isIntersecting: true,
        intersectionRatio: 1,
        boundingClientRect: target.getBoundingClientRect(),
        intersectionRect: target.getBoundingClientRect(),
        rootBounds: null,
        time: 0,
      };
      this.cb([entry], this);
    });
  }
  unobserve(target: Element): void {
    this.targets.delete(target);
  }
  disconnect(): void {
    this.targets.clear();
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

/**
 * Install the DOM stubs.
 *
 * Called at preload time *and* before every test: `--parallel` runs each file in
 * a fresh global, so assignments made once at preload don't reach the isolate
 * the tests actually execute in.
 *
 * Installed unconditionally — happy-dom ships an IntersectionObserver and a
 * ResizeObserver (jsdom did not), but neither ever fires a callback, so
 * lazy-on-visible components would never mount.
 */
/**
 * Inert WebSocket.
 *
 * With a real origin configured, components that open a live connection now
 * actually try to dial one, and the failure surfaces as an unhandled ErrorEvent
 * that fails the test. Tests that care about socket behaviour stub their own.
 */
class TestWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = TestWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  send(): void {}
  close(): void {
    this.readyState = TestWebSocket.CLOSED;
    // Handlers read event.code, so hand them a CloseEvent-shaped object.
    this.onclose?.({ code: 1000, reason: '', wasClean: true });
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

export function installDomObservers(): void {
  globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;
  globalThis.IntersectionObserver =
    TestIntersectionObserver as unknown as typeof IntersectionObserver;
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
  if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
}

installDomObservers();

// happy-dom doesn't implement ResizeObserver — fire one callback on observe so
// components that gate on host width can proceed in tests.
class TestResizeObserver {
  private readonly cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(target: Element): void {
    queueMicrotask(() => {
      this.cb([{ target } as ResizeObserverEntry], this);
    });
  }
  unobserve(): void {}
  disconnect(): void {}
}
