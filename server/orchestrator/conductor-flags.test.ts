import { describe, it, expect } from 'vitest';
import { claudeCodeHarness } from '../harnesses/claude-code.js';
import { shellQuoteSingle } from '../shell-quote.js';
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

  it('defaults to ORCHESTRATOR_SYSTEM_PROMPT when systemPrompt is omitted (byte-identical flags)', () => {
    const withDefault = buildOrchestratorConductorFlags({
      settingsPath: '/tmp/settings.local.json',
      mcpConfigPath: '/tmp/mcp-config.json',
    });
    const withExplicitDefault = buildOrchestratorConductorFlags({
      settingsPath: '/tmp/settings.local.json',
      mcpConfigPath: '/tmp/mcp-config.json',
      systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
    });

    expect(withDefault).toBe(withExplicitDefault);
    expect(withDefault).toContain(shellQuoteSingle(ORCHESTRATOR_SYSTEM_PROMPT));
  });

  it('uses a custom systemPrompt in --append-system-prompt when given', () => {
    const customPrompt = 'You are AGENT Foo. Only do X.';
    const flags = buildOrchestratorConductorFlags({
      settingsPath: '/tmp/settings.local.json',
      mcpConfigPath: '/tmp/mcp-config.json',
      systemPrompt: customPrompt,
    });

    expect(flags).toContain('--append-system-prompt');
    expect(flags).toContain(shellQuoteSingle(customPrompt));
    expect(flags).not.toContain(ORCHESTRATOR_SYSTEM_PROMPT);
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
