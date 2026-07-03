import { describe, it, expect } from 'vitest';
import { claudeCodeHarness } from '../harnesses/claude-code.js';
import { buildOrchestratorConductorFlags, ORCHESTRATOR_SYSTEM_PROMPT } from './conductor-flags.js';

describe('buildOrchestratorConductorFlags', () => {
  it('includes --settings, --append-system-prompt, and optional MCP flags', () => {
    const flags = buildOrchestratorConductorFlags({
      settingsPath: '/tmp/orch/settings.local.json',
      mcpConfigPath: '/tmp/orch/mcp-config.json',
      extraFlags: '--verbose',
    });

    expect(flags).toContain('--settings');
    expect(flags).toContain('/tmp/orch/settings.local.json');
    expect(flags).toContain('--mcp-config');
    expect(flags).toContain('--strict-mcp-config');
    expect(flags).toContain('/tmp/orch/mcp-config.json');
    expect(flags).toContain('--append-system-prompt');
    expect(flags).toContain(ORCHESTRATOR_SYSTEM_PROMPT.slice(0, 40));
    expect(flags).toContain('--verbose');
  });

  it('omits MCP flags when mcpConfigPath is null', () => {
    const flags = buildOrchestratorConductorFlags({
      settingsPath: '/tmp/settings.local.json',
      mcpConfigPath: null,
    });

    expect(flags).not.toContain('--mcp-config');
    expect(flags).not.toContain('--strict-mcp-config');
  });

  it('routes through harness buildLaunchCommand with orchestrator flags', () => {
    const flags = buildOrchestratorConductorFlags({
      settingsPath: '/tmp/settings.local.json',
      mcpConfigPath: '/tmp/mcp-config.json',
    });
    const cmd = claudeCodeHarness.buildLaunchCommand({ sessionId: 'sess-1', flags });

    expect(cmd).toBe(
      `claude --session-id sess-1 --settings '/tmp/settings.local.json' --mcp-config '/tmp/mcp-config.json' --strict-mcp-config --append-system-prompt '${ORCHESTRATOR_SYSTEM_PROMPT.replace(/'/g, `'\\''`)}'`,
    );
  });

  it('routes through harness buildResumeCommand with orchestrator flags', () => {
    const flags = buildOrchestratorConductorFlags({
      settingsPath: '/tmp/settings.local.json',
      mcpConfigPath: '/tmp/mcp-config.json',
    });
    const cmd = claudeCodeHarness.buildResumeCommand({ sessionId: 'sess-1', flags });

    expect(cmd).toContain('claude --resume sess-1');
    expect(cmd).toContain('--settings');
    expect(cmd).toContain('--strict-mcp-config');
    expect(cmd).toContain('--append-system-prompt');
  });
});
