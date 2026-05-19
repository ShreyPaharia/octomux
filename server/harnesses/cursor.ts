import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Harness, HarnessLaunchOpts, HarnessResumeOpts } from './types.js';
import { validateAgentName, validateFlagString } from './types.js';
import type { OctomuxSettings } from '../settings.js';

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
    const bridgeSrc = fileURLToPath(new URL('../../bin/octomux-hook-bridge.js', import.meta.url));
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
