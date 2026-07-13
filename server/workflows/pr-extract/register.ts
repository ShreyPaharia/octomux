import { PR_EXTRACT_OUTPUT_SCHEMA } from '@octomux/types';
import { registerWorkflow } from '../registry.js';
import { router as prExtractRouter } from '../../routes/pr-extracts.js';
import type { WorkflowType } from '../types.js';

export const prExtractWorkflow: WorkflowType = {
  kind: 'pr-extract',
  displayName: 'PR Extracts',
  surfaces: ['feed', 'artifact'],
  output: PR_EXTRACT_OUTPUT_SCHEMA as Record<string, unknown>,
  apiRouter: prExtractRouter,
};

registerWorkflow(prExtractWorkflow);
