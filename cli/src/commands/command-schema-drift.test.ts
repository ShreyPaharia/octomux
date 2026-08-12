/**
 * cli/src/commands/command-schema-drift.test.ts
 *
 * CLI DRIFT TEST (SHR-144).
 *
 * Asserts that the canonical zod schemas in `@octomux/capabilities` (schemas.ts)
 * stay in sync with the hand-written CLI commander option definitions that
 * remain in `cli/src/commands/`. If a flag is added to the CLI but not to the
 * schema (or vice-versa), this test fails — ensuring the MCP tools, the
 * executor, and the CLI can never silently diverge again.
 *
 * `create-task` / `list-tasks` / `get-task` / `delete-task` / `task-move` are no
 * longer hand-written commander commands — they're generated straight from
 * `TASK_CAPABILITY_META`'s zod schemas by `registerCapabilityCommands`
 * (`packages/capabilities/src/cli.ts`), so there is nothing left to drift for
 * those: the flags ARE the schema. Only `add-agent` remains hand-written and
 * therefore still needs this test.
 *
 * How the mapping works:
 *   Commander kebab-case flag  →  camelCase opt   →  schema snake_case field
 *   --repo-path                →  repoPath        →  repo_path
 *
 * Exclusion allowlist:
 *   ADD_AGENT_CLI_ONLY       — CLI-specific add-agent flags
 *                              (notifyAgent)
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import {
  sendMessageInputSchema,
  setStatusInputSchema,
  addAgentInputSchema,
  closeTaskInputSchema,
  deleteTaskInputSchema,
} from '@octomux/capabilities';
import { registerAddAgent } from './add-agent.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Collect commander option camelCase attribute names from a command. */
function collectCommanderKeys(cmd: Command): Set<string> {
  const keys = new Set<string>();
  for (const opt of cmd.options) {
    if (opt.long) {
      keys.add(opt.attributeName());
    }
  }
  return keys;
}

/** camelCase → snake_case (e.g. repoPath → repo_path). */
function toSnakeCase(camel: string): string {
  return camel.replace(/([A-Z])/g, (ch) => `_${ch.toLowerCase()}`);
}

/** Build a commander program that registers the given command. */
function buildProgram(register: (p: Command) => void): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  register(program);
  return program;
}

// ─── send_message ─────────────────────────────────────────────────────────────

describe('CLI drift test — sendMessageInputSchema', () => {
  it('requires task_id and message', () => {
    expect(sendMessageInputSchema.safeParse({ task_id: 't1', message: 'hi' }).success).toBe(true);
    expect(sendMessageInputSchema.safeParse({ task_id: 't1' }).success).toBe(false);
    expect(sendMessageInputSchema.safeParse({ message: 'hi' }).success).toBe(false);
  });
});

// ─── set_status ───────────────────────────────────────────────────────────────

describe('CLI drift test — setStatusInputSchema', () => {
  it('requires task_id and status', () => {
    expect(setStatusInputSchema.safeParse({ task_id: 't1', status: 'done' }).success).toBe(true);
    expect(setStatusInputSchema.safeParse({ task_id: 't1' }).success).toBe(false);
    expect(setStatusInputSchema.safeParse({ status: 'done' }).success).toBe(false);
  });
});

// ─── add_agent ────────────────────────────────────────────────────────────────

/**
 * CLI-specific add-agent flags that are translated before the server call:
 *   notifyAgent → notify_agent_id in the REST body (different key)
 */
const ADD_AGENT_CLI_ONLY: ReadonlySet<string> = new Set(['notifyAgent']);

/**
 * Explicit CLI camelCase → schema snake_case renames for add-agent:
 *   task → task_id  (CLI uses -t/--task; schema uses task_id)
 */
const ADD_AGENT_CLI_TO_SCHEMA: ReadonlyMap<string, string> = new Map([['task', 'task_id']]);

describe('CLI drift test — addAgentInputSchema', () => {
  it(
    'schema fields cover all CLI add-agent flags (minus CLI-only) ' +
      'and vice-versa — FAILS if either side adds/removes a flag',
    () => {
      const program = buildProgram(registerAddAgent);
      const addAgentCmd = program.commands.find((c) => c.name() === 'add-agent');
      expect(addAgentCmd, 'add-agent subcommand must be registered').toBeDefined();

      const cliSchemaKeys = new Set<string>();
      for (const cliKey of collectCommanderKeys(addAgentCmd!)) {
        if (ADD_AGENT_CLI_ONLY.has(cliKey)) continue;
        const schemaKey = ADD_AGENT_CLI_TO_SCHEMA.get(cliKey) ?? toSnakeCase(cliKey);
        cliSchemaKeys.add(schemaKey);
      }

      const schemaKeys = new Set(Object.keys(addAgentInputSchema.shape));

      const cliMissingFromSchema = [...cliSchemaKeys].filter((k) => !schemaKeys.has(k));
      const schemaMissingFromCli = [...schemaKeys].filter((k) => !cliSchemaKeys.has(k));

      expect(
        cliMissingFromSchema,
        `CLI flags missing from addAgentInputSchema: ${cliMissingFromSchema.join(', ')}`,
      ).toEqual([]);

      expect(
        schemaMissingFromCli,
        `Schema fields missing from CLI add-agent flags: ${schemaMissingFromCli.join(', ')}`,
      ).toEqual([]);
    },
  );

  it('schema requires task_id, allows optional agent opts', () => {
    expect(addAgentInputSchema.safeParse({ task_id: 't1' }).success).toBe(true);
    expect(addAgentInputSchema.safeParse({ task_id: 't1', prompt: 'do stuff' }).success).toBe(true);
    expect(addAgentInputSchema.safeParse({ prompt: 'do stuff' }).success).toBe(false);
  });
});

// ─── close_task + delete_task ─────────────────────────────────────────────────

describe('CLI drift test — closeTaskInputSchema', () => {
  it('requires task_id', () => {
    expect(closeTaskInputSchema.safeParse({ task_id: 't1' }).success).toBe(true);
    expect(closeTaskInputSchema.safeParse({}).success).toBe(false);
  });
});

describe('CLI drift test — deleteTaskInputSchema', () => {
  it('requires task_id', () => {
    expect(deleteTaskInputSchema.safeParse({ task_id: 't1' }).success).toBe(true);
    expect(deleteTaskInputSchema.safeParse({}).success).toBe(false);
  });
});
