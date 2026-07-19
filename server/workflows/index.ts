// Side-effect imports register all known workflow kinds.
import './doc-drift/register.js';
import './loops/register.js';
import './pr-extract/register.js';
import './prod-log-triage/register.js';
import './reviewer/register.js';

export { registerWorkflow, getWorkflow, listWorkflows } from './registry.js';
