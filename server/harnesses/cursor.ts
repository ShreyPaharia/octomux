import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import type { Harness, HarnessLaunchOpts, HarnessResumeOpts } from './types.js';
import { validateAgentName, validateFlagString } from './types.js';
import type { OctomuxSettings } from '../settings.js';
import { childLogger } from '../logger.js';

const execFile = promisify(execFileCb);
const logger = childLogger('harness:cursor');

/**
 * Regex matching the various wordings of Cursor's Workspace Trust prompt.
 * Cursor versions have used phrasings like:
 *   - "Trust this workspace?"
 *   - "Do you trust the authors of files in this folder?"
 *   - "Trust this folder?"
 * We match generously so we don't miss future minor reword variations.
 */
const TRUST_PROMPT_RE = /trust this (?:workspace|folder)|do you trust/i;
const TRUST_POLL_INTERVAL_MS = 200;
const TRUST_POLL_TIMEOUT_MS = 5000;

/**
 * Locate the bridge script. The source layout is `<root>/bin/octomux-hook-bridge.js`
 * but `import.meta.url` differs between dev (`<root>/server/harnesses/cursor.ts`
 * under tsx) and bundled production (`<root>/dist-server/harnesses-*.js`). Walk up
 * from the running module looking for the bin/ sibling.
 */
function resolveBridgeSource(): string {
  const startDir = path.dirname(fileURLToPath(import.meta.url));
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'bin', 'octomux-hook-bridge.js');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Cannot locate bin/octomux-hook-bridge.js from ${startDir} (walked up 6 levels)`);
}

export const cursorHarness: Harness = {
  id: 'cursor',
  displayName: 'Cursor',
  sessionIdMode: 'harness-issued',

  newSessionId(): string {
    return crypto.randomUUID();
  },

  buildLaunchCommand({ flags = '' }: HarnessLaunchOpts): string {
    return `cursor-agent${flags}`;
  },

  buildResumeCommand({ sessionId, flags = '' }: HarnessResumeOpts): string {
    return `cursor-agent --resume ${sessionId}${flags}`;
  },

  buildContinueCommand(_opts: HarnessResumeOpts): null {
    return null;
  },

  async installHooks(worktreePath: string, baseUrl: string, hookToken: string): Promise<void> {
    // 1. Create .octomux-hooks dir with 0700
    const hooksDir = path.join(worktreePath, '.octomux-hooks');
    fs.mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(hooksDir, 0o700);

    // 2. Copy bridge.js (0500)
    const bridgeSrc = resolveBridgeSource();
    const bridgeDest = path.join(hooksDir, 'bridge.js');
    fs.copyFileSync(bridgeSrc, bridgeDest);
    fs.chmodSync(bridgeDest, 0o500);

    // 3. Write config.json (0600)
    const configPath = path.join(hooksDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ baseUrl, token: hookToken }, null, 2) + '\n');
    fs.chmodSync(configPath, 0o600);

    // 4. Write .cursor/hooks.json
    const cursorDir = path.join(worktreePath, '.cursor');
    fs.mkdirSync(cursorDir, { recursive: true });
    const hookEntry = { command: bridgeDest, type: 'command', timeout: 5 };
    const hooksJson = {
      version: 1,
      hooks: {
        sessionStart: [hookEntry],
        beforeSubmitPrompt: [hookEntry],
        beforeShellExecution: [hookEntry],
        postToolUse: [hookEntry],
        afterFileEdit: [hookEntry],
      },
    };
    fs.writeFileSync(path.join(cursorDir, 'hooks.json'), JSON.stringify(hooksJson, null, 2) + '\n');
  },

  async syncAgents(_worktreePath: string): Promise<void> {
    // No-op: Cursor has no first-class custom-agents concept.
  },

  async postLaunch(target: string): Promise<void> {
    // Cursor shows a one-time "Trust this workspace" gate per new worktree.
    // --trust only works in --print mode, so we accept it interactively.
    // cursor-agent startup time varies (cold cache, npm shim, etc.) so we
    // poll the pane until we see the prompt or hit a timeout, instead of
    // a fixed sleep that misses slow starts.
    if (process.env.NODE_ENV === 'test') return;
    const start = Date.now();
    while (Date.now() - start < TRUST_POLL_TIMEOUT_MS) {
      let stdout: string;
      try {
        ({ stdout } = await execFile('tmux', ['capture-pane', '-t', target, '-p']));
      } catch (err) {
        logger.warn(
          { target, err: (err as Error).message },
          'cursor postLaunch: tmux capture-pane failed; abandoning trust auto-accept',
        );
        return;
      }
      if (TRUST_PROMPT_RE.test(stdout)) {
        try {
          await execFile('tmux', ['send-keys', '-t', target, 'a']);
          logger.info(
            { target, elapsed_ms: Date.now() - start },
            'cursor postLaunch: accepted Workspace Trust prompt',
          );
        } catch (err) {
          logger.warn(
            { target, err: (err as Error).message },
            'cursor postLaunch: tmux send-keys failed while accepting trust prompt',
          );
        }
        return;
      }
      await new Promise((r) => setTimeout(r, TRUST_POLL_INTERVAL_MS));
    }
    logger.info(
      { target, timeout_ms: TRUST_POLL_TIMEOUT_MS },
      'cursor postLaunch: no Workspace Trust prompt detected within timeout (workspace probably already trusted)',
    );
  },

  resolveFlags(settings: OctomuxSettings): string {
    const sub = (settings.harnesses?.['cursor'] ?? {}) as {
      flags?: string;
      force?: boolean;
    };

    const parts: string[] = [];
    if (sub.force) parts.push('--force');
    if (sub.flags) {
      parts.push(validateFlagString(sub.flags, 'harnesses.cursor.flags'));
    }
    return parts.length > 0 ? ` ${parts.join(' ')}` : '';
  },

  validateSettings(blob: unknown): Record<string, unknown> {
    if (typeof blob !== 'object' || blob === null || Array.isArray(blob)) {
      throw new Error('Invalid cursor settings: expected object');
    }
    const obj = blob as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const allowed = new Set(['flags', 'force']);
    for (const key of Object.keys(obj)) {
      if (!allowed.has(key)) {
        throw new Error(`Invalid cursor settings: unknown key "${key}"`);
      }
    }
    if (obj.flags !== undefined) {
      out.flags = validateFlagString(obj.flags as string, 'harnesses.cursor.flags');
    }
    if (obj.force !== undefined) {
      if (typeof obj.force !== 'boolean') {
        throw new Error('Invalid cursor.force: expected boolean');
      }
      out.force = obj.force;
    }
    return out;
  },

  validateAgentName(name: string): string {
    return validateAgentName(name);
  },
};
