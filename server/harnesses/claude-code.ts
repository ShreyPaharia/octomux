import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Harness, HarnessLaunchOpts, HarnessResumeOpts } from './types.js';
import { validateAgentName, validateFlagString } from './types.js';
import type { OctomuxSettings } from '../settings.js';

/** Strip any existing --model <value> from a flags string, then append --model <model>. */
function applyModel(flags: string, model: string | null | undefined): string {
  if (!model) return flags;
  const stripped = flags.replace(/\s*--model\s+\S+/g, '');
  return `${stripped} --model ${model}`;
}

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

  buildLaunchCommand({ sessionId, agent, flags = '', model }: HarnessLaunchOpts): string {
    const agentPart = agent ? ` --agent ${validateAgentName(agent)}` : '';
    const resolvedFlags = applyModel(flags, model);
    return `claude${agentPart} --session-id ${sessionId}${resolvedFlags}`;
  },

  buildResumeCommand({ sessionId, flags = '', model }: HarnessResumeOpts): string {
    const resolvedFlags = applyModel(flags, model);
    return `claude --resume ${sessionId}${resolvedFlags}`;
  },

  buildContinueCommand({ sessionId, flags = '', model }: HarnessResumeOpts): string {
    const resolvedFlags = applyModel(flags, model);
    return `claude --continue --session-id ${sessionId}${resolvedFlags}`;
  },

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
    fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n');
  },

  async syncAgents(worktreePath: string) {
    const { listAgents, getAgent } = await import('../agents.js');
    const targetDir = path.join(worktreePath, '.claude', 'agents');
    await fs.promises.mkdir(targetDir, { recursive: true });

    const agents = await listAgents();
    for (const def of agents) {
      const agent = await getAgent(def.name);
      await fs.promises.writeFile(path.join(targetDir, `${def.name}.md`), agent.content, 'utf-8');
    }
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
    return parts.length > 0 ? ` ${parts.join(' ')}` : '';
  },

  validateSettings(blob: unknown): Record<string, unknown> {
    if (typeof blob !== 'object' || blob === null || Array.isArray(blob)) {
      throw new Error('Invalid claude-code settings: expected object');
    }
    const obj = blob as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    if (obj.flags !== undefined) {
      out.flags = validateFlagString(obj.flags as string, 'harnesses.claude-code.flags');
    }
    if (obj.dangerouslySkipPermissions !== undefined) {
      if (typeof obj.dangerouslySkipPermissions !== 'boolean') {
        throw new Error('Invalid claude-code.dangerouslySkipPermissions: expected boolean');
      }
      out.dangerouslySkipPermissions = obj.dangerouslySkipPermissions;
    }
    return out;
  },

  validateAgentName(name: string): string {
    return validateAgentName(name);
  },
};
