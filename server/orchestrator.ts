import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

const execFile = promisify(execFileCb);

const ORCHESTRATOR_SESSION = 'octomux-orchestrator';

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
  await execFile('tmux', ['send-keys', '-t', ORCHESTRATOR_SESSION, 'claude', 'Enter']);
}

export async function stopOrchestrator(): Promise<void> {
  await execFile('tmux', ['kill-session', '-t', ORCHESTRATOR_SESSION]).catch(() => {});
}

export function getOrchestratorSession(): string {
  return ORCHESTRATOR_SESSION;
}
