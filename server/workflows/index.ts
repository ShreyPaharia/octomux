// Side-effect imports register all known workflow kinds.
import './daily-plan/index.js';
import './doc-drift/index.js';
import './overnight-log-summary/index.js';
import './pr-extract/index.js';
import './prod-log-triage/index.js';
import './reviewer/index.js';
import './slack-watcher/index.js';
import './slack-watcher/send-reply.js';
import './weekly-update/index.js';

// Presets merge in last — task/chat preset validation (§3.2) depends on the
// code handlers above already being registered.
import { reloadPresets } from './presets.js';
reloadPresets();

export { registerWorkflow, getWorkflow, listWorkflows, listCronWorkflowKinds } from './registry.js';
export {
  getPreset,
  listPresets,
  loadPresets,
  mergePresetsIntoRegistry,
  reloadPresets,
} from './presets.js';
