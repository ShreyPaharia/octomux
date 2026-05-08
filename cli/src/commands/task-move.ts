import { Command } from 'commander';
import { getContext } from '../action.js';
import { outputJson, success, label } from '../format.js';
import type { WorkflowStatus } from '../client.js';

const VALID_STATUSES: WorkflowStatus[] = [
  'backlog',
  'planned',
  'in_progress',
  'human_review',
  'pr',
  'done',
];

export function registerTaskMove(program: Command): void {
  program
    .command('task-move <id> <workflow_status>')
    .description(`Move a task to a workflow column (${VALID_STATUSES.join(' | ')})`)
    .option('-n, --note <note>', 'optional note to attach to the move')
    .action(async (id: string, workflowStatus: string, opts, cmd) => {
      const { client, json } = getContext(cmd);

      if (!VALID_STATUSES.includes(workflowStatus as WorkflowStatus)) {
        console.error(`Invalid workflow_status: ${workflowStatus}`);
        console.error(`Valid values: ${VALID_STATUSES.join(', ')}`);
        process.exit(1);
      }

      const task = await client.moveTask(id, {
        workflow_status: workflowStatus as WorkflowStatus,
        note: opts.note,
      });

      if (json) {
        outputJson(task);
        return;
      }

      success(`Moved task ${task.id} → ${workflowStatus}`);
      console.log(label('Title', task.title));
      console.log(label('Workflow', task.workflow_status));
    });
}
