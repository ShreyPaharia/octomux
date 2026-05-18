import crypto from 'crypto';
import type { Harness, HarnessLaunchOpts, HarnessResumeOpts } from './types.js';
import { validateAgentName } from './types.js';
import type { OctomuxSettings } from '../settings.js';

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

  async installHooks(_worktreePath: string, _baseUrl: string, _hookToken: string) {
    throw new Error('claudeCodeHarness.installHooks not yet ported');
  },

  async syncAgents(_worktreePath: string) {
    throw new Error('claudeCodeHarness.syncAgents not yet ported');
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
