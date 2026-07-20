// Side-effect imports register all known workflow UI kinds. doc-drift, pr-extract, and
// prod-log-triage no longer register client UI — their runs render generically on /runs
// (spec/workflow-consolidation.md §3.2).
import './loops/register';

export { registerWorkflowUI, getWorkflowUI, listWorkflowUIs } from './registry';
