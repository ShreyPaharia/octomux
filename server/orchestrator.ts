import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { getAgent, saveAgent, resetAgent } from './agents.js';

const execFile = promisify(execFileCb);

const ORCHESTRATOR_SESSION = 'octomux-orchestrator';

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
    await execFile('tmux', ['has-session', '-t', ORCHESTRATOR_SESSION]);
    return true;
  } catch {
    return false;
  }
}

export async function startOrchestrator(cwd?: string, initialMessage?: string): Promise<void> {
  if (await isOrchestratorRunning()) return;
  await execFile('tmux', [
    'new-session',
    '-d',
    '-s',
    ORCHESTRATOR_SESSION,
    '-c',
    cwd || process.cwd(),
  ]);

  const customPrompt = await getCustomPrompt();

  let claudeCmd: string;
  if (customPrompt) {
    // Custom prompt: write to temp file and use --system-prompt
    const tmpPrompt = path.join(os.tmpdir(), 'octomux-orchestrator-prompt.md');
    await fs.promises.writeFile(tmpPrompt, customPrompt, 'utf-8');
    claudeCmd = `claude --system-prompt "$(cat ${tmpPrompt})"`;
  } else {
    // Default: use the agent definition
    claudeCmd = 'claude --agent orchestrator';
  }

  // Use single quotes for the user message to prevent shell interpretation of $, `, etc.
  const messagePart = initialMessage ? ` '${initialMessage.replace(/'/g, "'\"'\"'")}'` : '';
  claudeCmd += messagePart;

  await execFile('tmux', ['send-keys', '-t', ORCHESTRATOR_SESSION, claudeCmd, 'Enter']);
}

export async function sendToOrchestrator(message: string): Promise<void> {
  if (!(await isOrchestratorRunning())) {
    throw new Error('Orchestrator is not running');
  }
  // Use -l (literal) to prevent tmux from interpreting key names in the message.
  // Must be a separate call from 'Enter' because -l makes ALL args literal.
  await execFile('tmux', ['send-keys', '-l', '-t', ORCHESTRATOR_SESSION, message]);
  await execFile('tmux', ['send-keys', '-t', ORCHESTRATOR_SESSION, 'Enter']);
}

/** Type message into orchestrator terminal WITHOUT pressing Enter. User reviews and sends. */
export async function typeToOrchestrator(message: string): Promise<void> {
  if (!(await isOrchestratorRunning())) {
    throw new Error('Orchestrator is not running');
  }
  await execFile('tmux', ['send-keys', '-l', '-t', ORCHESTRATOR_SESSION, message]);
}

export async function stopOrchestrator(): Promise<void> {
  await execFile('tmux', ['kill-session', '-t', ORCHESTRATOR_SESSION]).catch(() => {});
}

export function getOrchestratorSession(): string {
  return ORCHESTRATOR_SESSION;
}
