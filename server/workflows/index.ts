// Side-effect imports register all known workflow kinds.
import './loops/register.js';
import './pr-extract/register.js';

export { registerWorkflow, getWorkflow, listWorkflows } from './registry.js';
