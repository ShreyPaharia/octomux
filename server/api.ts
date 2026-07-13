import type { Express, Request, Response } from 'express';
import { seedInlineComment } from './repositories/inline-comments.js';
import { seedReviewRun } from './repositories/review-runs.js';
import { mountArtifactEndpoint } from './orchestrator/artifact-endpoint.js';
import { hookRoutes } from './hooks.js';
import './workflows/index.js';

import { router as miscRouter } from './routes/misc.js';
import { router as learningsRouter } from './routes/learnings.js';
import { router as skillsRouter } from './routes/skills.js';
import { router as savedFilesRouter } from './routes/saved-files.js';
import { router as teamsRouter } from './routes/teams.js';
import { router as setupRouter } from './routes/setup.js';
import { router as settingsRouter } from './routes/settings.js';
import { router as hooksRegistryRouter } from './routes/hooks-registry.js';
import { router as chatsRouter } from './routes/chats.js';
import { router as agentDefsRouter } from './routes/agent-defs.js';
import { router as orchestratorRouter } from './routes/orchestrator.js';
import { router as integrationsRouter } from './routes/integrations.js';
import { router as reviewsRouter } from './routes/reviews.js';
import { router as reviewRunsRouter } from './routes/review-runs.js';
import { router as loopsRouter } from './routes/loops.js';
import { router as prExtractsRouter } from './routes/pr-extracts.js';
import { router as commentsRouter } from './routes/comments.js';
import { router as diffsRouter } from './routes/diffs.js';
import { router as tasksRouter } from './routes/tasks.js';
import { router as taskWorkflowRouter } from './routes/task-workflow.js';
import { router as taskAgentsRouter } from './routes/task-agents.js';
import { router as worktreesRouter } from './routes/worktrees.js';

import { insertWorktreeIfAbsent, insertTaskIfAbsent, inTransaction } from './repositories/index.js';

export function setupRoutes(app: Express): void {
  app.use('/api/hooks', hookRoutes);
  mountArtifactEndpoint(app);

  // Mount extracted routers (bare app.use — each router keeps full /api/... paths)
  app.use(miscRouter);
  app.use(learningsRouter);
  app.use(skillsRouter);
  app.use(savedFilesRouter);
  app.use(teamsRouter);
  app.use(setupRouter);
  app.use(settingsRouter);
  app.use(hooksRegistryRouter);
  app.use(chatsRouter);
  app.use(agentDefsRouter);
  app.use(orchestratorRouter);
  app.use(integrationsRouter);
  app.use(reviewsRouter);
  app.use(reviewRunsRouter);
  app.use(loopsRouter);
  app.use(prExtractsRouter);
  app.use(commentsRouter);
  app.use(diffsRouter);
  app.use(tasksRouter);
  app.use(taskWorkflowRouter);
  app.use(taskAgentsRouter);
  app.use(worktreesRouter);

  // ─── Test-only seed endpoint ─────────────────────────────────────────────────
  // Gated strictly on NODE_ENV=test. Never exposed in production.
  if (process.env.NODE_ENV === 'test') {
    /**
     * POST /api/__test__/seed-review
     * Seeds a review task, a review run, and inline comments directly in the DB.
     *
     * The worktrees row uses:
     *  - `path`      = process.cwd()      — so `git show <sha>:<file>` resolves
     *  - `repo_path` = '/tmp/e2e-norepo'  — so deleteTask's `git worktree remove`
     *                                        fails gracefully on a non-existent repo
     *
     * This ensures staleness checks work with real SHAs/files while preventing
     * deleteTask from accidentally removing the server's working directory.
     */
    app.post('/api/__test__/seed-review', (req: Request, res: Response) => {
      const body = req.body as {
        task: {
          id: string;
          title: string;
          pr_url: string;
          pr_number: number;
          pr_head_sha: string;
        };
        review_run: {
          id: string;
          walkthrough: string;
        };
        comments: Array<{
          id: string;
          file_path: string;
          line: number;
          side: 'old' | 'new';
          body: string;
          kind: 'comment' | 'suggestion';
          severity?: string;
          bucket?: string;
          existing_code?: string | null;
          suggested_code?: string | null;
        }>;
      };

      inTransaction(() => {
        const wtId = `wt-${body.task.id}`;
        // `path` = server's cwd so git-show works; `repo_path` = non-existent so
        // deleteTask's git-worktree-remove fails gracefully without deleting cwd.
        insertWorktreeIfAbsent({
          id: wtId,
          path: process.cwd(),
          repo_path: '/tmp/e2e-norepo',
          branch: 'review/e2e',
          base_branch: 'main',
          mode: 'new',
          status: 'available',
        });

        insertTaskIfAbsent({
          id: body.task.id,
          title: body.task.title,
          description: '',
          runtime_state: 'idle',
          workflow_status: 'backlog',
          source: 'auto_review',
          worktree_id: wtId,
          pr_url: body.task.pr_url,
          pr_number: body.task.pr_number,
          pr_head_sha: body.task.pr_head_sha,
        });

        seedReviewRun({
          id: body.review_run.id,
          task_id: body.task.id,
          pr_head_sha: body.task.pr_head_sha,
          walkthrough: body.review_run.walkthrough,
        });

        for (const c of body.comments) {
          seedInlineComment({
            id: c.id,
            task_id: body.task.id,
            review_run_id: body.review_run.id,
            file_path: c.file_path,
            line: c.line,
            side: c.side,
            original_commit_sha: body.task.pr_head_sha,
            body: c.body,
            kind: c.kind,
            severity: c.severity ?? null,
            bucket: c.bucket ?? null,
            existing_code: c.existing_code ?? null,
            suggested_code: c.suggested_code ?? null,
          });
        }
      });

      res.json({ task_id: body.task.id });
    });
  }
}
