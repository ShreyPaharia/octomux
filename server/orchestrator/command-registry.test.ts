/**
 * server/orchestrator/command-registry.test.ts
 *
 * Unit tests for the command registry (SHR-145).
 *
 * Verifies:
 *  - Every OrchestratorAction has exactly one CommandDef in COMMANDS.
 *  - MCP-exposed commands (mcp:true) have a non-empty name, summary, and schema.
 *  - MCP tool names are unique.
 *  - getCommandByAction routes to the correct CommandDef.
 *  - resume-task is mcp:false.
 *  - The set of MCP tool names matches the 6 expected names from the previous
 *    hand-written registerWriteTools (ensuring the refactor is a pure rename).
 */

import { describe, it, expect } from 'vitest';
import { COMMANDS, getCommandByAction } from './command-registry.js';
import type { OrchestratorAction } from './command-registry.js';
import { ORCHESTRATOR_ACTIONS } from './actions.js';

// ─── All OrchestratorActions have a CommandDef ────────────────────────────────

describe('COMMANDS coverage', () => {
  it('every OrchestratorAction has exactly one CommandDef', () => {
    const allActions: OrchestratorAction[] = [
      'create-task',
      'send-message',
      'add-agent',
      'set-status',
      'close-task',
      'resume-task',
      'delete-task',
    ];

    for (const action of allActions) {
      const matches = COMMANDS.filter((c) => c.action === action);
      expect(matches, `expected exactly one CommandDef for action "${action}"`).toHaveLength(1);
    }
  });

  it('COMMANDS covers exactly the same set as ORCHESTRATOR_ACTIONS', () => {
    const registryActions = new Set(COMMANDS.map((c) => c.action));
    // Every action in ORCHESTRATOR_ACTIONS must be in the registry.
    for (const action of ORCHESTRATOR_ACTIONS) {
      expect(
        registryActions.has(action as OrchestratorAction),
        `ORCHESTRATOR_ACTIONS contains "${action}" but COMMANDS does not`,
      ).toBe(true);
    }
    // And vice versa.
    for (const action of registryActions) {
      expect(
        ORCHESTRATOR_ACTIONS.has(action),
        `COMMANDS contains "${action}" but ORCHESTRATOR_ACTIONS does not`,
      ).toBe(true);
    }
  });
});

// ─── MCP-exposed commands ─────────────────────────────────────────────────────

describe('MCP-exposed commands (mcp:true)', () => {
  const mcpCommands = COMMANDS.filter((c) => c.mcp);

  it('have a non-empty name', () => {
    for (const cmd of mcpCommands) {
      expect(cmd.name.trim().length, `mcp command "${cmd.action}" has empty name`).toBeGreaterThan(
        0,
      );
    }
  });

  it('have a non-empty summary (description)', () => {
    for (const cmd of mcpCommands) {
      expect(
        cmd.summary.trim().length,
        `mcp command "${cmd.action}" has empty summary`,
      ).toBeGreaterThan(0);
    }
  });

  it('have a zod schema with a .shape property (object schema)', () => {
    for (const cmd of mcpCommands) {
      expect(cmd.input, `mcp command "${cmd.action}" is missing input schema`).toBeDefined();
      // ZodObject exposes .shape; ZodTypeAny does not.
      expect(
        typeof (cmd.input as { shape?: unknown }).shape,
        `mcp command "${cmd.action}" schema has no .shape (must be a ZodObject)`,
      ).toBe('object');
    }
  });

  it('have unique names across all MCP tools', () => {
    const names = mcpCommands.map((c) => c.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('exposes exactly the 6 expected tool names (same as the pre-SHR-145 hand-written list)', () => {
    const expectedNames = new Set([
      'create_task',
      'send_message',
      'set_task_status',
      'add_agent',
      'close_task',
      'delete_task',
    ]);
    const actualNames = new Set(mcpCommands.map((c) => c.name));
    expect(actualNames).toEqual(expectedNames);
  });
});

// ─── resume-task is mcp:false ─────────────────────────────────────────────────

describe('resume-task', () => {
  it('is mcp:false (not exposed as an MCP write tool)', () => {
    const resumeDef = getCommandByAction('resume-task');
    expect(resumeDef).toBeDefined();
    expect(resumeDef!.mcp).toBe(false);
  });

  it('still has a valid input schema (minimal z.object with task_id)', () => {
    const resumeDef = getCommandByAction('resume-task');
    expect(resumeDef!.input).toBeDefined();
    // Must accept a task_id field without throwing.
    const parsed = resumeDef!.input.parse({ task_id: 'abc123' });
    expect(parsed).toMatchObject({ task_id: 'abc123' });
  });
});

// ─── getCommandByAction routing ───────────────────────────────────────────────

describe('getCommandByAction', () => {
  it.each([
    ['create-task', 'create_task'],
    ['send-message', 'send_message'],
    ['add-agent', 'add_agent'],
    ['set-status', 'set_task_status'],
    ['close-task', 'close_task'],
    ['resume-task', 'resume_task'],
    ['delete-task', 'delete_task'],
  ] as [OrchestratorAction, string][])(
    'routes "%s" to the correct CommandDef (name="%s")',
    (action, expectedName) => {
      const cmd = getCommandByAction(action);
      expect(cmd).toBeDefined();
      expect(cmd!.action).toBe(action);
      expect(cmd!.name).toBe(expectedName);
    },
  );

  it('returns undefined for an unknown action', () => {
    // Cast to bypass type system — simulates an unexpected runtime value.
    const cmd = getCommandByAction('bogus-action' as OrchestratorAction);
    expect(cmd).toBeUndefined();
  });
});
