import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Harness, HarnessLaunchOpts, HarnessResumeOpts } from './types.js';
import { validateAgentName } from './types.js';
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

  buildLaunchCommand({ sessionId, agent, flags = '' }: HarnessLaunchOpts): string {
    const agentPart = agent ? ` --agent ${validateAgentName(agent)}` : '';
    return `claude${agentPart} --session-id ${sessionId}${flags}`;
  },

  buildResumeCommand({ sessionId, flags = '' }: HarnessResumeOpts): string {
    return `claude --resume ${sessionId}${flags}`;
  },

  buildContinueCommand({ sessionId, flags = '' }: HarnessResumeOpts): string {
    return `claude --continue --session-id ${sessionId}${flags}`;
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

  resolveFlags(_settings: OctomuxSettings): string {
    throw new Error('claudeCodeHarness.resolveFlags not yet ported');
  },

  validateSettings(_blob: unknown): Record<string, unknown> {
    throw new Error('claudeCodeHarness.validateSettings not yet ported');
  },

  validateAgentName(name: string): string {
    return validateAgentName(name);
  },
};
