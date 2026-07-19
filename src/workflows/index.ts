// Side-effect imports register all known workflow UI kinds.
import './loops/register';
import './pr-extract/register';
import './prod-log-triage/register';

export { registerWorkflowUI, getWorkflowUI, listWorkflowUIs } from './registry';
