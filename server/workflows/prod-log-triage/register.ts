import { registerWorkflow } from '../registry.js';
import { registerScheduleHandler } from '../../schedules/handlers.js';
import { createTriageTaskFromSchedule } from '../../services/prod-log-triage-service.js';
import { childLogger } from '../../logger.js';
import type { WorkflowType } from '../types.js';
import type { ScheduleRow } from '../../repositories/schedules.js';

const logger = childLogger('workflows/prod-log-triage');

const DEFAULT_LOG_COMMAND = 'gh run list --limit 20 --json databaseId,conclusion,name,url';
// Scoped to THIS task's branch (via --head), not repo-wide — a stale PR
// elsewhere titled "fix" must not satisfy this. Repos should append their
// own build/test clause via per-schedule config (see config_json, FIX 3).
const DEFAULT_VERIFY =
  'test -f "desk/incidents/$(date +%F).md" && [ -n "$(gh pr list --head "$(git rev-parse --abbrev-ref HEAD)" --state open --json number --jq \'.[0].number\')" ]';
const DEFAULT_MAX_ITERATIONS = 5;

export const prodLogTriageWorkflow: WorkflowType = {
  kind: 'prod-log-triage',
  displayName: 'Prod Log Triage',
  surfaces: ['feed', 'artifact'],
  // No `output`/sink — the fix PRs opened via `gh` inside the run are the product.
};

registerWorkflow(prodLogTriageWorkflow);

async function handleProdLogTriageSchedule(row: ScheduleRow): Promise<void> {
  logger.info({ repo_path: row.repo_path, schedule_id: row.id }, 'prod-log-triage: schedule fired');
  const cfg = row.config_json ? JSON.parse(row.config_json) : {};
  await createTriageTaskFromSchedule({
    repoPath: row.repo_path,
    logCommand: cfg.logCommand ?? DEFAULT_LOG_COMMAND,
    verify: cfg.verify ?? DEFAULT_VERIFY,
    maxIterations: cfg.maxIterations ?? DEFAULT_MAX_ITERATIONS,
  });
}

registerScheduleHandler('prod-log-triage', handleProdLogTriageSchedule);
