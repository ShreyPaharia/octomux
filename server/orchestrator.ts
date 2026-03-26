import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const execFile = promisify(execFileCb);

const ORCHESTRATOR_SESSION = 'octomux-orchestrator';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROMPT_FILE = path.resolve(__dirname, 'orchestrator-prompt.md');

function customPromptPath(): string {
  return path.join(os.homedir(), '.octomux', 'orchestrator-prompt.md');
}

export async function getCustomPrompt(): Promise<string | null> {
  try {
    return await fs.promises.readFile(customPromptPath(), 'utf-8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function getDefaultPrompt(): Promise<string> {
  return fs.promises.readFile(DEFAULT_PROMPT_FILE, 'utf-8');
}

export async function getOrchestratorPrompt(): Promise<string> {
  const custom = await getCustomPrompt();
  return custom ?? (await getDefaultPrompt());
}

export async function saveCustomPrompt(content: string): Promise<void> {
  const filePath = customPromptPath();
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, content, 'utf-8');
}

export async function resetCustomPrompt(): Promise<void> {
  try {
    await fs.promises.unlink(customPromptPath());
  } catch (err: any) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
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
  const promptContent = await getOrchestratorPrompt();
  const tmpPrompt = path.join(os.tmpdir(), 'octomux-orchestrator-prompt.md');
  await fs.promises.writeFile(tmpPrompt, promptContent, 'utf-8');
  // Use single quotes for the user message to prevent shell interpretation of $, `, etc.
  const messagePart = initialMessage
    ? ` '${initialMessage.replace(/'/g, "'\"'\"'")}'`
    : '';
  const claudeCmd = `claude --system-prompt "$(cat ${tmpPrompt})"${messagePart}`;
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
