import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { getAgent, saveAgent, resetAgent, syncAgents } from './agents.js';
import { getSettings, resolveClaudeFlags } from './settings.js';
import { childLogger } from './logger.js';
import { getDb, ORCHESTRATOR_AGENT_ID, ORCHESTRATOR_TMUX_SESSION } from './db.js';

const execFile = promisify(execFileCb);
const logger = childLogger('orchestrator');

/**
 * Read the orchestrator's tmux session name from its pinned agent row.
 * Falls back to the well-known constant if the row isn't seeded yet (test
 * harnesses that call orchestrator helpers before initDb).
 */
function readOrchestratorSession(): string {
  try {
    const row = getDb()
      .prepare(`SELECT tmux_session FROM agents WHERE id = ?`)
      .get(ORCHESTRATOR_AGENT_ID) as { tmux_session: string | null } | undefined;
    return row?.tmux_session ?? ORCHESTRATOR_TMUX_SESSION;
  } catch {
    return ORCHESTRATOR_TMUX_SESSION;
  }
}

/** Update the orchestrator agent row's status. Silent on DB errors. */
function writeOrchestratorStatus(
  status: 'running' | 'idle' | 'stopped',
): void {
  try {
    getDb()
      .prepare(
        `UPDATE agents
            SET status = ?, hook_activity = ?, hook_activity_updated_at = datetime('now')
          WHERE id = ?`,
      )
      .run(status, status === 'running' ? 'active' : 'idle', ORCHESTRATOR_AGENT_ID);
  } catch {
    // non-critical — row may not exist yet (tests)
  }
}

export async function getCustomPrompt(): Promise<string | null> {
  const agent = await getAgent('orchestrator');
  return agent.isCustom ? agent.content : null;
}

export async function getDefaultPrompt(): Promise<string> {
  const agent = await getAgent('orchestrator');
  return agent.defaultContent;
}

export async function getOrchestratorPrompt(): Promise<string> {
  const agent = await getAgent('orchestrator');
  return agent.content;
}

export async function saveCustomPrompt(content: string): Promise<void> {
  await saveAgent('orchestrator', content);
}

export async function resetCustomPrompt(): Promise<void> {
  await resetAgent('orchestrator');
}

export async function isOrchestratorRunning(): Promise<boolean> {
  try {
    await execFile('tmux', ['has-session', '-t', readOrchestratorSession()]);
    return true;
  } catch {
    return false;
  }
}

export async function startOrchestrator(cwd?: string, initialMessage?: string): Promise<void> {
  logger.info(
    { operation: 'startOrchestrator', has_initial_message: !!initialMessage },
    'startOrchestrator: start',
  );

  if (await isOrchestratorRunning()) {
    logger.info(
      { operation: 'startOrchestrator' },
      'startOrchestrator: already running — skipping',
    );
    return;
  }

  try {
    // Sync agent files to .claude/agents/ so `claude --agent` can find them
    await syncAgents();

    await execFile('tmux', [
      'new-session',
      '-d',
      '-s',
      readOrchestratorSession(),
      '-c',
      cwd || process.cwd(),
    ]);
    logger.info(
      { operation: 'startOrchestrator', tmux_session: readOrchestratorSession() },
      'startOrchestrator: tmux session created',
    );

    const settings = await getSettings();

    let claudeCmd: string;
    if (settings.useOrchestratorAgent) {
      // Use the orchestrator agent definition from .claude/agents/
      claudeCmd = 'claude --agent orchestrator';
    } else {
      // Plain claude with no agent
      claudeCmd = 'claude';
    }

    // Append user-configured launch flags (env var > settings).
    claudeCmd += resolveClaudeFlags(settings);

    // Use single quotes for the user message to prevent shell interpretation of $, `, etc.
    const messagePart = initialMessage ? ` '${initialMessage.replace(/'/g, "'\"'\"'")}'` : '';
    claudeCmd += messagePart;

    await execFile('tmux', ['send-keys', '-t', readOrchestratorSession(), claudeCmd, 'Enter']);
    writeOrchestratorStatus('running');
    logger.info(
      { operation: 'startOrchestrator', use_orchestrator_agent: settings.useOrchestratorAgent },
      'startOrchestrator: complete',
    );
  } catch (err) {
    logger.error({ operation: 'startOrchestrator', err }, 'startOrchestrator: failed');
    writeOrchestratorStatus('stopped');
    throw err;
  }
}

export async function sendToOrchestrator(message: string): Promise<void> {
  if (!(await isOrchestratorRunning())) {
    logger.warn(
      { operation: 'sendToOrchestrator' },
      'sendToOrchestrator: orchestrator not running',
    );
    throw new Error('Orchestrator is not running');
  }
  // Use -l (literal) to prevent tmux from interpreting key names in the message.
  // Must be a separate call from 'Enter' because -l makes ALL args literal.
  await execFile('tmux', ['send-keys', '-l', '-t', readOrchestratorSession(), message]);
  await execFile('tmux', ['send-keys', '-t', readOrchestratorSession(), 'Enter']);
}

/** Type message into orchestrator terminal WITHOUT pressing Enter. User reviews and sends. */
export async function typeToOrchestrator(message: string): Promise<void> {
  if (!(await isOrchestratorRunning())) {
    logger.warn(
      { operation: 'typeToOrchestrator' },
      'typeToOrchestrator: orchestrator not running',
    );
    throw new Error('Orchestrator is not running');
  }
  await execFile('tmux', ['send-keys', '-l', '-t', readOrchestratorSession(), message]);
}

export async function stopOrchestrator(): Promise<void> {
  logger.info({ operation: 'stopOrchestrator' }, 'stopOrchestrator: start');
  try {
    await execFile('tmux', ['kill-session', '-t', readOrchestratorSession()]);
    logger.info(
      { operation: 'stopOrchestrator', tmux_session: readOrchestratorSession() },
      'stopOrchestrator: complete',
    );
  } catch (err) {
    logger.warn(
      { operation: 'stopOrchestrator', err },
      'stopOrchestrator: kill-session failed (already stopped?)',
    );
  }
  writeOrchestratorStatus('stopped');
}

export function getOrchestratorSession(): string {
  return readOrchestratorSession();
}
