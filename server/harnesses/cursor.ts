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

const OCTOMUX_CURSOR_RULE_PREFIX = 'octomux-agent-';

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

function shellQuoteSingle(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function workspaceCliArg(workspacePath: string): string {
  return ` --workspace ${shellQuoteSingle(workspacePath)}`;
}

/**
 * Parse the first YAML frontmatter block from an octomux agent Markdown file,
 * returning key/value pairs and the body below the closing `---`.
 */
function parseAgentMarkdown(content: string): { fm: Record<string, string>; body: string } {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: content.trim() };
  const fm: Record<string, string> = {};
  for (const rawLine of m[1].split('\n')) {
    const km = rawLine.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!km) continue;
    let v = km[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    fm[km[1]] = v;
  }
  return { fm, body: m[2].trim() };
}

function agentMarkdownToCursorRule(agentName: string, rawContent: string): string {
  const { fm, body } = parseAgentMarkdown(rawContent);
  const summary =
    fm.description || fm.name
      ? [fm.description, fm.name === agentName ? undefined : fm.name].filter(Boolean).join(' · ')
      : '';
  const description = summary.trim() ? summary : `Octomux agent (${agentName})`;
  const safeDesc = JSON.stringify(description);
  return `---
description: ${safeDesc}
alwaysApply: false
---

<!--
  Synced from octomux agent definitions for Cursor CLI sessions in this workspace.
  Personas mirror Claude Code --agent presets; edit definitions under Settings → Agents.
  Harness → Cursor lets you append CLI flags (--resume, --model, etc.).
-->

${body}
`;
}

function pruneOctomuxCursorRules(rulesDir: string): void {
  if (!fs.existsSync(rulesDir)) return;
  for (const ent of fs.readdirSync(rulesDir, { withFileTypes: true })) {
    if (!ent.isFile()) continue;
    if (
      ent.name.startsWith(OCTOMUX_CURSOR_RULE_PREFIX) &&
      (ent.name.endsWith('.mdc') || ent.name.endsWith('.md'))
    ) {
      fs.unlinkSync(path.join(rulesDir, ent.name));
    }
  }
}

function expectedHooksPayload(bridgeDest: string): string {
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
  return JSON.stringify(hooksJson, null, 2) + '\n';
}

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

  buildLaunchCommand({ flags = '', workspacePath }: HarnessLaunchOpts): string {
    const ws = workspacePath ? workspaceCliArg(workspacePath) : '';
    return `cursor-agent${ws}${flags}`;
  },

  buildResumeCommand({ sessionId, flags = '', workspacePath }: HarnessResumeOpts): string {
    const ws = workspacePath ? workspaceCliArg(workspacePath) : '';
    return `cursor-agent${ws} --resume ${sessionId}${flags}`;
  },

  buildContinueCommand(_opts: HarnessResumeOpts): null {
    return null;
  },

  async installHooks(worktreePath: string, baseUrl: string, hookToken: string): Promise<void> {
    const hooksDir = path.join(worktreePath, '.octomux-hooks');
    fs.mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(hooksDir, 0o700);

    const bridgeSrc = resolveBridgeSource();
    const bridgeDest = path.join(hooksDir, 'bridge.js');
    try {
      if (fs.existsSync(bridgeDest)) {
        fs.chmodSync(bridgeDest, 0o600);
      }
    } catch {
      /* best-effort: dest may not exist yet or be inaccessible */
    }
    fs.copyFileSync(bridgeSrc, bridgeDest);
    fs.chmodSync(bridgeDest, 0o500);

    const expectedConfig = JSON.stringify({ baseUrl, token: hookToken }, null, 2) + '\n';
    const configPath = path.join(hooksDir, 'config.json');
    try {
      if (!fs.existsSync(configPath) || fs.readFileSync(configPath, 'utf-8') !== expectedConfig) {
        fs.writeFileSync(configPath, expectedConfig, { mode: 0o600 });
      }
    } catch {
      fs.writeFileSync(configPath, expectedConfig, { mode: 0o600 });
    }
    fs.chmodSync(configPath, 0o600);

    const hooksJsonExpected = expectedHooksPayload(bridgeDest);
    const cursorDir = path.join(worktreePath, '.cursor');
    fs.mkdirSync(cursorDir, { recursive: true });
    const hooksJsonPath = path.join(cursorDir, 'hooks.json');
    try {
      if (
        !fs.existsSync(hooksJsonPath) ||
        fs.readFileSync(hooksJsonPath, 'utf-8') !== hooksJsonExpected
      ) {
        fs.writeFileSync(hooksJsonPath, hooksJsonExpected);
      }
    } catch {
      fs.writeFileSync(hooksJsonPath, hooksJsonExpected);
    }
  },

  async syncAgents(worktreePath: string): Promise<void> {
    const { listAgents, getAgent } = await import('../agents.js');
    const rulesDir = path.join(worktreePath, '.cursor', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    pruneOctomuxCursorRules(rulesDir);

    const defs = await listAgents();
    for (const def of defs) {
      try {
        const detail = await getAgent(def.name);
        const raw = `${OCTOMUX_CURSOR_RULE_PREFIX}${def.name}.mdc`;
        const dest = path.join(rulesDir, raw);
        const next = agentMarkdownToCursorRule(def.name, detail.content);
        try {
          if (fs.existsSync(dest) && fs.readFileSync(dest, 'utf-8') === next) continue;
        } catch {
          /* stale read — overwrite */
        }
        fs.writeFileSync(dest, next, 'utf-8');
      } catch (err) {
        logger.warn(
          { worktree_path: worktreePath, agent: def.name, err: (err as Error).message },
          'cursor syncAgents: failed to mirror agent definition',
        );
      }
    }
  },

  async postLaunch(target: string): Promise<void> {
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
    };

    const parts: string[] = [];
    if (sub.force || dangerousAllow) {
      parts.push('--force');
    }
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
