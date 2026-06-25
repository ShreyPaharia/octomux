// Side-effect imports register all known harnesses.
import './claude-code.js';
import './cursor.js';

export * from './types.js';
export { registerHarness, getHarness, listHarnesses, DEFAULT_HARNESS_ID } from './registry.js';
export { claudeCodeHarness } from './claude-code.js';
export { cursorHarness } from './cursor.js';
