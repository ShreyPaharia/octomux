/**
 * Lightweight wrapper around `claude -p` for short Haiku-class calls
 * (summaries, titles). Runs in a fresh tmpdir with no tools, no slash commands,
 * no project settings — piggybacks on the user's existing Claude Code auth
 * (OAuth / subscription / ANTHROPIC_API_KEY in their CC config). No separate
 * API key needed.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { childLogger } from './logger.js';

const execFileP = promisify(execFile);
const logger = childLogger('claude-cli');

export interface RunClaudeOpts {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

/**
 * Run `claude -p` in an isolated tmpdir and return stdout (trimmed).
 * Throws on non-zero exit, timeout, or missing binary — callers handle.
 */
export async function runClaudePrint(opts: RunClaudeOpts): Promise<string> {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-cc-'));
  try {
    const args = [
      '-p',
      '--model',
      opts.model ?? 'haiku',
      '--tools',
      '',
      '--no-session-persistence',
      '--disable-slash-commands',
      '--setting-sources',
      'user',
      ...(opts.systemPrompt ? ['--system-prompt', opts.systemPrompt] : []),
      opts.prompt,
    ];

    const { stdout } = await execFileP('claude', args, {
      cwd: tmpdir,
      timeout: opts.timeoutMs ?? 30_000,
      maxBuffer: opts.maxBufferBytes ?? 1024 * 1024,
    });

    return stdout.trim();
  } finally {
    try {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    } catch (err) {
      logger.debug({ err, tmpdir }, 'tmpdir cleanup failed');
    }
  }
}
