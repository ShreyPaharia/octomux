// Side-effect imports register all known workflow UI kinds.
import './loops/register';
import './pr-extract/register';

export { registerWorkflowUI, getWorkflowUI, listWorkflowUIs } from './registry';
