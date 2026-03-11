import { execFile as execFileCb, spawn } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { nanoid } from 'nanoid';
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

  // Write a launcher script that reads the prompt from a file and passes it
  // to claude via a variable. This avoids shell interpolation issues — the
  // original `$(cat file)` inside double quotes would expand $, backticks,
  // and backslashes found in the prompt content.
  const launcherId = nanoid(6);
  const promptPath = path.join(os.tmpdir(), `octomux-orch-prompt-${launcherId}.txt`);
  const launcherPath = path.join(os.tmpdir(), `octomux-orch-launch-${launcherId}.sh`);
  fs.copyFileSync(PROMPT_FILE, promptPath);
  fs.writeFileSync(
    launcherPath,
    `#!/bin/sh\nprompt=$(cat '${promptPath}')\nexec claude --system-prompt "$prompt"\n`,
    { mode: 0o755 },
  );

  await execFile('tmux', [
    'send-keys',
    '-t',
    ORCHESTRATOR_SESSION,
    `sh '${launcherPath}'`,
    'Enter',
  ]);
}

export async function stopOrchestrator(): Promise<void> {
  await execFile('tmux', ['kill-session', '-t', ORCHESTRATOR_SESSION]).catch(() => {});
}

export function getOrchestratorSession(): string {
  return ORCHESTRATOR_SESSION;
}
