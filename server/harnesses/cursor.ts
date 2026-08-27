import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { assetRoot } from '../assets.js';
import type { Harness, HarnessLaunchOpts, HarnessResumeOpts } from './types.js';
import { validateAgentName, validateFlagString } from './types.js';
import {
  flagsSuffix,
  formatHarnessFlags,
  formatJsonConfig,
  validateSettingsObject,
} from './shared.js';
import { registerHarness } from './registry.js';
import type { OctomuxSettings } from '../settings.js';
import { childLogger } from '../logger.js';
import { execTmux } from '../tmux-bin.js';
import { shellQuoteSingle } from '../shell-quote.js';
import type { ComputeFiles } from '../compute/types.js';
import { localFiles } from '../compute/index.js';

const logger = childLogger('harness:cursor');

/** Default cursor-agent model when harnesses.cursor.model and flags omit --model. */
export const CURSOR_DEFAULT_MODEL = 'composer-2.5';

const CURSOR_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateCursorModel(model: string): string {
  const trimmed = model.trim();
  if (!CURSOR_MODEL_RE.test(trimmed)) {
    throw new Error(
      `Invalid harnesses.cursor.model: ${JSON.stringify(model)}. Use an id from cursor-agent --list-models`,
    );
  }
  return trimmed;
}

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

function workspaceCliArg(workspacePath: string): string {
  return ` --workspace ${shellQuoteSingle(workspacePath)}`;
}

function hooksJsonObject(bridgeDest: string) {
  const hookEntry = { command: bridgeDest, type: 'command', timeout: 5 };
  return {
    version: 1,
    hooks: {
      sessionStart: [hookEntry],
      beforeSubmitPrompt: [hookEntry],
      beforeShellExecution: [hookEntry],
      postToolUse: [hookEntry],
      afterFileEdit: [hookEntry],
    },
  };
}

/**
 * Locate the bridge script at `<assetRoot()>/bin/octomux-hook-bridge.js` — the
 * compiled binary only has it in the extracted runtime dir, never next to
 * `import.meta.url` ($bunfs).
 */
function resolveBridgeSource(): string {
  const candidate = path.join(assetRoot(), 'bin', 'octomux-hook-bridge.js');
  if (fs.existsSync(candidate)) return candidate;
  throw new Error(`Cannot locate octomux-hook-bridge.js at ${candidate}`);
}

export const cursorHarness: Harness = {
  id: 'cursor',
  displayName: 'Cursor',
  sessionIdMode: 'harness-issued',
  binaryName: 'cursor-agent',
  installHint: 'curl https://cursor.com/install -fsS | bash',

  newSessionId(): string {
    return crypto.randomUUID();
  },

  buildLaunchCommand({ flags = '', workspacePath }: HarnessLaunchOpts): string {
    const ws = workspacePath ? workspaceCliArg(workspacePath) : '';
    return `cursor-agent${ws}${flagsSuffix(flags)}`;
  },

  buildResumeCommand({ sessionId, flags = '', workspacePath }: HarnessResumeOpts): string {
    const ws = workspacePath ? workspaceCliArg(workspacePath) : '';
    return `cursor-agent${ws} --resume ${sessionId}${flagsSuffix(flags)}`;
  },

  buildContinueCommand(_opts: HarnessResumeOpts): null {
    return null;
  },

  async installHooks(
    worktreePath: string,
    baseUrl: string,
    hookToken: string,
    files: ComputeFiles = localFiles,
  ): Promise<void> {
    const hooksDir = path.join(worktreePath, '.octomux-hooks');
    // Holds the hook token — kept owner-only even if the dir already existed
    // (mkdirp chmods an existing dir too, see server/compute/local.ts).
    await files.mkdirp(hooksDir, { mode: 0o700 });

    // bridgeSrc is octomux's own bundled asset, resolved from the running
    // server module — it lives on the SERVER's disk regardless of which
    // compute the workspace is on, so this stays real `fs`, not `files`.
    const bridgeSrc = resolveBridgeSource();
    const bridgeDest = path.join(hooksDir, 'bridge.js');
    const bridgeContent = fs.readFileSync(bridgeSrc, 'utf-8');
    // bridge.js ends up 0o500 (no write bit for anyone), so a prior install's
    // file can't be overwritten in place — `write`'s chmod-after-write can't
    // save it either, since the write itself EACCESs first. Delete, then
    // `write` creates it fresh at the target mode.
    await files.rm(bridgeDest).catch(() => {});
    await files.write(bridgeDest, bridgeContent, { mode: 0o500 });

    const expectedConfig = formatJsonConfig({ baseUrl, token: hookToken });
    const configPath = path.join(hooksDir, 'config.json');
    const existingConfig = await files.read(configPath).catch(() => null);
    if (existingConfig !== expectedConfig) {
      await files.write(configPath, expectedConfig, { mode: 0o600 });
    } else {
      // Content already matches — still fix the mode in case something
      // external left it wrong; `write` is skipped so it can't chmod for us.
      await files.chmod(configPath, 0o600);
    }

    const hooksJsonObj = hooksJsonObject(bridgeDest);
    const hooksJsonExpected = formatJsonConfig(hooksJsonObj);
    const cursorDir = path.join(worktreePath, '.cursor');
    await files.mkdirp(cursorDir);
    const hooksJsonPath = path.join(cursorDir, 'hooks.json');
    const existingHooksJson = await files.read(hooksJsonPath).catch(() => null);
    if (existingHooksJson !== hooksJsonExpected) {
      await files.write(hooksJsonPath, hooksJsonExpected);
    }
  },

  async uninstallHooks(dirPath: string, files: ComputeFiles = localFiles): Promise<void> {
    // `.cursor/hooks.json` is written wholesale by installHooks and every entry
    // points at our bridge — drop it only when that still holds, so a
    // hand-edited file survives.
    const hooksJsonPath = path.join(dirPath, '.cursor', 'hooks.json');
    try {
      const raw = await files.read(hooksJsonPath);
      if (raw !== null && raw.includes('.octomux-hooks')) {
        await files.rm(hooksJsonPath);
      }
    } catch {
      /* absent or unreadable — nothing to clean */
    }
    await files.rm(path.join(dirPath, '.octomux-hooks'), { recursive: true });
  },

  async postLaunch(target: string): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    const start = Date.now();
    while (Date.now() - start < TRUST_POLL_TIMEOUT_MS) {
      let stdout: string;
      try {
        ({ stdout } = await execTmux(['capture-pane', '-t', target, '-p']));
      } catch (err) {
        logger.warn(
          { target, err: (err as Error).message },
          'cursor postLaunch: tmux capture-pane failed; abandoning trust auto-accept',
        );
        return;
      }
      if (TRUST_PROMPT_RE.test(stdout)) {
        try {
          await execTmux(['send-keys', '-t', target, 'a']);
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
    const ccHarness = settings.harnesses?.['claude-code'] as
      | { dangerouslySkipPermissions?: unknown }
      | undefined;
    const dangerouslyFromHarness =
      typeof ccHarness?.dangerouslySkipPermissions === 'boolean'
        ? ccHarness.dangerouslySkipPermissions
        : false;
    const dangerousAllow = dangerouslyFromHarness || Boolean(settings.dangerouslySkipPermissions);

    const sub = (settings.harnesses?.['cursor'] ?? {}) as {
      flags?: string;
      force?: boolean;
      model?: string;
    };

    const parts: string[] = [];
    if (sub.force || dangerousAllow) {
      parts.push('--force');
    }
    if (sub.flags) {
      parts.push(validateFlagString(sub.flags, 'harnesses.cursor.flags'));
    }
    const joined = parts.join(' ');
    if (!/\B--model\b/.test(joined)) {
      const modelId =
        typeof sub.model === 'string' && sub.model.trim()
          ? validateCursorModel(sub.model)
          : CURSOR_DEFAULT_MODEL;
      parts.push(`--model ${modelId}`);
    }
    return formatHarnessFlags(parts);
  },

  validateSettings(blob: unknown): Record<string, unknown> {
    return validateSettingsObject(
      blob,
      'cursor',
      {
        flags: (value) => validateFlagString(value as string, 'harnesses.cursor.flags'),
        force: (value) => {
          if (typeof value !== 'boolean') {
            throw new Error('Invalid cursor.force: expected boolean');
          }
          return value;
        },
        model: (value) => {
          if (typeof value !== 'string') {
            throw new Error('Invalid cursor.model: expected string');
          }
          const trimmed = value.trim();
          if (trimmed) return validateCursorModel(trimmed);
          return undefined;
        },
      },
      { rejectUnknownKeys: true },
    );
  },

  validateAgentName(name: string): string {
    return validateAgentName(name);
  },
};

registerHarness(cursorHarness);

export default cursorHarness;
