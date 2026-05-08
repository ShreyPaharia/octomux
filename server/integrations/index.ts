// Side-effect imports register all known providers.
import './jira/index.js';

export { registerProvider, getProvider, listProviders } from './registry.js';
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
