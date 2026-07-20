import { PR_EXTRACT_OUTPUT_SCHEMA } from '@octomux/types';
import { registerWorkflow } from '../registry.js';
import { createExtractTaskFromMergedPr } from './run.js';
import { router as prExtractRouter } from './routes.js';
import type { RunContext, WorkflowType } from '../types.js';

export interface PrExtractMergedPrEvent {
  branch: string;
  base_branch: string;
  pr_number: number;
  pr_url: string | null;
  pr_head_sha: string;
  title: string;
}

export const prExtractWorkflow: WorkflowType = {
  kind: 'pr-extract',
  displayName: 'PR Extracts',
  surfaces: ['feed', 'artifact'],
  output: PR_EXTRACT_OUTPUT_SCHEMA as Record<string, unknown>,
  apiRouter: prExtractRouter,
  trigger: { kind: 'github', event: 'pr_merged' },
  run: async (ctx: RunContext) => {
    const event = ctx.event as PrExtractMergedPrEvent;
    await createExtractTaskFromMergedPr({
      repo_path: ctx.repoPath,
      branch: event.branch,
      base_branch: event.base_branch,
      pr_number: event.pr_number,
      pr_url: event.pr_url,
      pr_head_sha: event.pr_head_sha,
      title: event.title,
    });
  },
};

registerWorkflow(prExtractWorkflow);
