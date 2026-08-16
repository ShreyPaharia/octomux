/**
 * jest-dom matcher types for `bun:test`.
 *
 * @testing-library/jest-dom ships augmentations for jest and vitest only; the
 * matchers themselves are registered in `src/bun-test-setup.ts`, so this just
 * teaches TypeScript about them.
 */
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

declare module 'bun:test' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Matchers<T = unknown> extends TestingLibraryMatchers<unknown, T> {}
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface AsymmetricMatchers extends TestingLibraryMatchers<unknown, unknown> {}
}
