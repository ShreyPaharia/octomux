import { registerWorkflow } from '../registry.js';
import { registerScheduleHandler } from '../../schedules/handlers.js';
import { createDocDriftTaskFromSchedule } from '../../services/doc-drift-service.js';
import { childLogger } from '../../logger.js';
import type { WorkflowType } from '../types.js';
import type { ScheduleRow } from '../../repositories/schedules.js';

const logger = childLogger('workflows/doc-drift');

// Scoped to THIS task's branch — docs changed on the branch AND a PR already
// open on it (mirrors prod-log-triage's --head scoping so a stale PR
// elsewhere never satisfies this).
const DEFAULT_VERIFY =
  '[ -n "$(git diff --name-only origin/HEAD... -- \'*.md\' 2>/dev/null)" ] && [ -n "$(gh pr list --head "$(git rev-parse --abbrev-ref HEAD)" --state open --json number --jq \'.[0].number\')" ]';
const DEFAULT_MAX_ITERATIONS = 4;

export const docDriftWorkflow: WorkflowType = {
  kind: 'doc-drift',
  displayName: 'Doc Drift',
  surfaces: ['feed', 'artifact'],
  // No `output`/sink — the doc-fix PR opened via `gh` inside the run is the product.
  trigger: { kind: 'cron' },
};

registerWorkflow(docDriftWorkflow);

async function handleDocDriftSchedule(row: ScheduleRow): Promise<void> {
  logger.info({ repo_path: row.repo_path, schedule_id: row.id }, 'doc-drift: schedule fired');
  const cfg = row.config_json ? JSON.parse(row.config_json) : {};
  await createDocDriftTaskFromSchedule({
    repoPath: row.repo_path,
    verify: cfg.verify ?? DEFAULT_VERIFY,
    maxIterations: cfg.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    scheduleId: row.id,
  });
}

registerScheduleHandler('doc-drift', handleDocDriftSchedule);
