import { registerWorkflow } from '../registry.js';
import { router as loopsRouter } from '../../routes/loops.js';
import type { WorkflowType } from '../types.js';

export const loopsWorkflow: WorkflowType = {
  kind: 'loops',
  displayName: 'Loops',
  surfaces: ['feed', 'artifact', 'session'],
  apiRouter: loopsRouter,
};

registerWorkflow(loopsWorkflow);
