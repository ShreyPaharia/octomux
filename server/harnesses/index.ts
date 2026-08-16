// Side-effect imports register all known harnesses.
import './claude-code.js';
import './cursor.js';
import { freezeCoreHarnesses } from './registry.js';

// Lock the core ids against redefinition now that both have registered, and
// before any plugin harness gets a chance to load.
freezeCoreHarnesses();

export * from './types.js';
export {
  applyModel,
  buildClaudeContinueCommand,
  buildClaudeLaunchCommand,
  buildClaudeResumeCommand,
  formatHarnessFlags,
  formatJsonConfig,
  validateSettingsObject,
  writeJsonConfig,
} from './shared.js';
export {
  registerHarness,
  getHarness,
  listHarnesses,
  DEFAULT_HARNESS_ID,
  CORE_HARNESS_IDS,
  freezeCoreHarnesses,
  resetHarnesses,
} from './registry.js';
export { claudeCodeHarness } from './claude-code.js';
export { cursorHarness } from './cursor.js';
