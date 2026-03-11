import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const execFile = promisify(execFileCb);

const ORCHESTRATOR_SESSION = 'octomux-orchestrator';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_FILE = path.resolve(__dirname, 'orchestrator-prompt.md');

export async function isOrchestratorRunning(): Promise<boolean> {
  try {
    await execFile('tmux', ['has-session', '-t', ORCHESTRATOR_SESSION]);
    return true;
  } catch {
    return false;
  }
}

export async function startOrchestrator(cwd?: string): Promise<void> {
  if (await isOrchestratorRunning()) return;
  await execFile('tmux', [
    'new-session',
    '-d',
    '-s',
    ORCHESTRATOR_SESSION,
    '-c',
    cwd || process.cwd(),
  ]);
  const claudeCmd = `claude --system-prompt "$(cat ${PROMPT_FILE})"`;
  await execFile('tmux', ['send-keys', '-t', ORCHESTRATOR_SESSION, claudeCmd, 'Enter']);
}

export async function stopOrchestrator(): Promise<void> {
  await execFile('tmux', ['kill-session', '-t', ORCHESTRATOR_SESSION]).catch(() => {});
}

export function getOrchestratorSession(): string {
  return ORCHESTRATOR_SESSION;
}
