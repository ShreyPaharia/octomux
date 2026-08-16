/**
 * Vitest-shaped surface over `bun:test` for the frontend suite.
 *
 * Also re-installs the observer stubs: `bun test --parallel` gives each file a
 * fresh global, so the copies installed by the --preload file don't reach the
 * isolate the tests run in, and lazy-on-visible components never mount.
 */

import { installDomObservers } from './bun-test-setup.js';

installDomObservers();

export * from '../server/bun-test.js';
