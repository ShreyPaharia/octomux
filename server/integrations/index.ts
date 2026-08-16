// Side-effect imports register all known providers.
import './jira/index.js';
import './linear/index.js';
import './slack-gateway/index.js';
import './telegram-gateway/index.js';
import { freezeCoreProviders } from './registry.js';

// Lock the core provider kinds now that all four have registered, and before
// any plugin provider gets a chance to load. Mirrors harnesses/index.ts.
freezeCoreProviders();

export {
  registerProvider,
  getProvider,
  listProviders,
  CORE_PROVIDER_KINDS,
  freezeCoreProviders,
  resetProviders,
} from './registry.js';
export {
  listIntegrations,
  getIntegration,
  createIntegration,
  updateIntegration,
  deleteIntegration,
  setEnabled,
} from './store.js';
export { maskConfig, maskIntegration, mergeMaskedConfig } from './mask.js';
export type { IntegrationProvider, Integration, ValidationResult, JsonSchema } from './types.js';
