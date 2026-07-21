import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Harness } from './types.js';
import { validateAgentName, validateFlagString } from './types.js';
import {
  buildClaudeContinueCommand,
  buildClaudeLaunchCommand,
  buildClaudeResumeCommand,
  formatHarnessFlags,
  validateSettingsObject,
  writeJsonConfig,
} from './shared.js';
import { registerHarness } from './registry.js';
import type { OctomuxSettings } from '../settings.js';

function buildHookEvents(baseUrl: string, token: string) {
  const url = (event: string) => `${baseUrl}/api/hooks/${event}?token=${encodeURIComponent(token)}`;
  return {
    UserPromptSubmit: [{ hooks: [{ type: 'http', url: url('user-prompt-submit'), timeout: 5 }] }],
    PermissionRequest: [{ hooks: [{ type: 'http', url: url('permission-request'), timeout: 5 }] }],
    PostToolUse: [{ hooks: [{ type: 'http', url: url('post-tool-use'), timeout: 5 }] }],
    Stop: [{ hooks: [{ type: 'http', url: url('stop'), timeout: 5 }] }],
  };
}

export const claudeCodeHarness: Harness = {
  id: 'claude-code',
  displayName: 'Claude Code',
  sessionIdMode: 'orchestrator-assigned',

  newSessionId() {
    return crypto.randomUUID();
  },

  buildLaunchCommand: buildClaudeLaunchCommand,
  buildResumeCommand: buildClaudeResumeCommand,
  buildContinueCommand: buildClaudeContinueCommand,

  async installHooks(worktreePath: string, baseUrl: string, hookToken: string) {
    const { ALLOWED_TOOLS, DENIED_TOOLS } = await import('../hook-settings.js');
    const claudeDir = path.join(worktreePath, '.claude');
    const settingsPath = path.join(claudeDir, 'settings.local.json');
    fs.mkdirSync(claudeDir, { recursive: true });

    let existing: Record<string, unknown> = {};
    try {
      const raw = fs.readFileSync(settingsPath, 'utf-8');
      existing = JSON.parse(raw);
      if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
        existing = {};
      }
    } catch {
      existing = {};
    }

    const existingHooks =
      typeof existing.hooks === 'object' &&
      existing.hooks !== null &&
      !Array.isArray(existing.hooks)
        ? (existing.hooks as Record<string, unknown>)
        : {};
    const mergedHooks = { ...existingHooks, ...buildHookEvents(baseUrl, hookToken) };

    const existingPerms =
      typeof existing.permissions === 'object' &&
      existing.permissions !== null &&
      !Array.isArray(existing.permissions)
        ? (existing.permissions as Record<string, unknown>)
        : {};
    const existingAllow = Array.isArray(existingPerms.allow)
      ? (existingPerms.allow as string[])
      : [];
    const mergedAllow = [...new Set([...ALLOWED_TOOLS, ...existingAllow])];
    const existingDeny = Array.isArray(existingPerms.deny) ? (existingPerms.deny as string[]) : [];
    const mergedDeny = [...new Set([...DENIED_TOOLS, ...existingDeny])];
    const mergedPermissions = { ...existingPerms, allow: mergedAllow, deny: mergedDeny };

    const merged = { ...existing, permissions: mergedPermissions, hooks: mergedHooks };
    writeJsonConfig(settingsPath, merged);
  },

  async syncAgents(_worktreePath: string) {
    // Vendored agents ship in the bundled octomux plugin (`--plugin-dir`).
  },

  resolveFlags(settings: OctomuxSettings): string {
    const envFlagsRaw = process.env.OCTOMUX_CLAUDE_FLAGS?.trim();
    if (envFlagsRaw) {
      const envFlags = validateFlagString(envFlagsRaw, 'OCTOMUX_CLAUDE_FLAGS');
      return ` ${envFlags}`;
    }

    const sub = (settings.harnesses?.['claude-code'] ?? {}) as {
      flags?: string;
      dangerouslySkipPermissions?: boolean;
    };

    const parts: string[] = [];
    if (sub.dangerouslySkipPermissions) parts.push('--dangerously-skip-permissions');
    if (sub.flags) {
      parts.push(validateFlagString(sub.flags, 'harnesses.claude-code.flags'));
    }
    return formatHarnessFlags(parts);
  },

  validateSettings(blob: unknown): Record<string, unknown> {
    return validateSettingsObject(blob, 'claude-code', {
      flags: (value) => validateFlagString(value as string, 'harnesses.claude-code.flags'),
      dangerouslySkipPermissions: (value) => {
        if (typeof value !== 'boolean') {
          throw new Error('Invalid claude-code.dangerouslySkipPermissions: expected boolean');
        }
        return value;
      },
    });
  },

  validateAgentName(name: string): string {
    return validateAgentName(name);
  },
};

registerHarness(claudeCodeHarness);
