import { registerWorkflow } from '../registry.js';
import { childLogger } from '../../logger.js';
import { runSlackWatcher } from './run.js';
import { SLACK_WATCHER_CONFIG_SCHEMA, SLACK_WATCHER_SCHEMA } from './schema.js';
import type { RunContext, WorkflowType } from '../types.js';

const logger = childLogger('workflows/slack-watcher');

export const slackWatcherWorkflow: WorkflowType = {
  kind: 'slack-watcher',
  displayName: 'Slack Watcher',
  surfaces: ['artifact'],
  config: SLACK_WATCHER_CONFIG_SCHEMA,
  output: SLACK_WATCHER_SCHEMA,
  trigger: { kind: 'cron' },
  run: (ctx: RunContext) => {
    logger.info(
      { repo_path: ctx.repoPath, schedule_id: ctx.scheduleId },
      'slack-watcher: schedule fired',
    );
    const cfg = ctx.config as {
      slackUserId: string;
      digestTarget: string;
      telegramChatId: string;
      digestUserId: string;
      lookbackMinutes: number;
      digestChannel: string;
    };

    // Fire-and-forget: runSlackWatcher blocks for the full headless agent run.
    void runSlackWatcher({
      repoPath: ctx.repoPath,
      scheduleId: ctx.scheduleId,
      slackUserId: cfg.slackUserId,
      digestTarget: cfg.digestTarget,
      telegramChatId: cfg.telegramChatId,
      digestUserId: cfg.digestUserId,
      lookbackMinutes: cfg.lookbackMinutes,
      digestChannel: cfg.digestChannel,
      trigger: ctx.trigger,
    }).catch((err) => {
      logger.error(
        { err, repo_path: ctx.repoPath, schedule_id: ctx.scheduleId },
        'slack-watcher: run failed',
      );
    });
    return Promise.resolve();
  },
};

registerWorkflow(slackWatcherWorkflow);
