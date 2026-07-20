// Side-effect imports register all known workflow kinds.
import './daily-plan/index.js';
import './doc-drift/index.js';
import './loops/index.js';
import './overnight-log-summary/index.js';
import './pr-extract/index.js';
import './prod-log-triage/index.js';
import './reviewer/index.js';
import './weekly-update/index.js';

export { registerWorkflow, getWorkflow, listWorkflows, listCronWorkflowKinds } from './registry.js';
