/**
 * cli/src/commands/command-schema-drift.test.ts
 *
 * CLI DRIFT TEST (SHR-144).
 *
 * Asserts that the canonical zod schemas in server/orchestrator/command-schemas.ts
 * stay in sync with the CLI commander option definitions. If a flag is added to
 * the CLI but not to the schema (or vice-versa), this test fails — ensuring the
 * MCP tools, the executor, and the CLI can never silently diverge again.
 *
 * How the mapping works:
 *   Commander kebab-case flag  →  camelCase opt   →  schema snake_case field
 *   --repo-path                →  repoPath        →  repo_path
 *   --base-branch              →  baseBranch      →  base_branch
 *   --initial-prompt           →  initialPrompt   →  initial_prompt
 *   --mode                     →  mode            →  run_mode (explicit rename)
 *   --worktree-path            →  worktreePath    →  worktree_path
 *   --notify-task              →  notifyTask      →  notify_task
 *
 * Exclusion allowlists:
 *   CREATE_TASK_SCHEMA_ONLY  — orchestrator-only extensions not on the CLI
 *                              (kind, effort, conversation_id)
 *   CREATE_TASK_CLI_ONLY     — CLI-specific flags that the server never sees
 *                              (draft, harness, forkFrom)
 *   ADD_AGENT_CLI_ONLY       — CLI-specific add-agent flags
 *                              (notifyAgent)
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import {
  createTaskInputSchema,
  sendMessageInputSchema,
  setStatusInputSchema,
  addAgentInputSchema,
  closeTaskInputSchema,
  deleteTaskInputSchema,
} from '../../../server/orchestrator/command-schemas.js';
import { registerCreateTask } from './create-task.js';
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

// ─── create_task ──────────────────────────────────────────────────────────────

/**
 * Orchestrator-only extensions not present on the CLI. Excluding these keeps the
 * drift test focused on fields that MUST match between CLI and schema. These are
 * injected by the server or provided only by the conductor session, never by CLI users.
 */
const CREATE_TASK_SCHEMA_ONLY: ReadonlySet<string> = new Set([
  'kind', // orchestrator workflow kind: plan / implement / workflow
  'effort', // model right-sizing advisory hint
  'conversation_id', // server-injected; conductor conversation that owns the task
]);

/**
 * CLI-specific flags that are resolved/translated before the REST call reaches
 * the executor, so they are intentionally absent from the schema:
 *
 *   draft     → CLI passes { draft: true } in the REST body (separate key)
 *   harness   → CLI passes { harness_id: ... } (different key)
 *   forkFrom  → CLI resolves to base_branch before calling the API
 */
const CREATE_TASK_CLI_ONLY: ReadonlySet<string> = new Set(['draft', 'harness', 'forkFrom']);

/**
 * Explicit CLI camelCase → schema snake_case renames for fields where the
 * standard camelCase-to-snake_case conversion gives the wrong result:
 *   mode → run_mode  (CLI uses --mode; schema field is run_mode)
 */
const CREATE_TASK_CLI_TO_SCHEMA: ReadonlyMap<string, string> = new Map([['mode', 'run_mode']]);

describe('CLI drift test — createTaskInputSchema', () => {
  it(
    'schema fields cover all CLI create-task flags (minus CLI-only) ' +
      'and vice-versa (minus schema-only) — FAILS if either side adds/removes a flag',
    () => {
      const program = buildProgram(registerCreateTask);
      const createTaskCmd = program.commands.find((c) => c.name() === 'create-task');
      expect(createTaskCmd, 'create-task subcommand must be registered').toBeDefined();

      // CLI camelCase keys → schema snake_case keys
      const cliSchemaKeys = new Set<string>();
      for (const cliKey of collectCommanderKeys(createTaskCmd!)) {
        if (CREATE_TASK_CLI_ONLY.has(cliKey)) continue;
        const schemaKey = CREATE_TASK_CLI_TO_SCHEMA.get(cliKey) ?? toSnakeCase(cliKey);
        cliSchemaKeys.add(schemaKey);
      }

      // Schema keys present on the CLI (exclude orchestrator-only extensions)
      const schemaKeys = new Set(
        Object.keys(createTaskInputSchema.shape).filter((k) => !CREATE_TASK_SCHEMA_ONLY.has(k)),
      );

      const cliMissingFromSchema = [...cliSchemaKeys].filter((k) => !schemaKeys.has(k));
      const schemaMissingFromCli = [...schemaKeys].filter((k) => !cliSchemaKeys.has(k));

      expect(
        cliMissingFromSchema,
        `CLI flags mapped to these schema keys but the keys are missing from createTaskInputSchema.` +
          ` Add them to the schema or to CREATE_TASK_CLI_ONLY: ${cliMissingFromSchema.join(', ')}`,
      ).toEqual([]);

      expect(
        schemaMissingFromCli,
        `Schema has these fields but they have no matching CLI flag.` +
          ` Add --${schemaMissingFromCli.map((k) => k.replace(/_/g, '-')).join(' / --')} to the CLI` +
          ` or add the fields to CREATE_TASK_SCHEMA_ONLY: ${schemaMissingFromCli.join(', ')}`,
      ).toEqual([]);
    },
  );

  it('schema parses valid create-task input', () => {
    const r = createTaskInputSchema.safeParse({
      title: 'Fix bug',
      description: 'Description',
      repo_path: '/tmp/repo',
      run_mode: 'new',
    });
    expect(r.success).toBe(true);
  });

  it('schema rejects invalid run_mode', () => {
    const r = createTaskInputSchema.safeParse({
      title: 'T',
      description: 'd',
      run_mode: 'invalid-mode',
    });
    expect(r.success).toBe(false);
  });

  it('schema rejects invalid kind', () => {
    const r = createTaskInputSchema.safeParse({ title: 'T', description: 'd', kind: 'bogus' });
    expect(r.success).toBe(false);
  });
});

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

// ─── Schema surface area guard ────────────────────────────────────────────────

describe('createTaskInputSchema field surface area guard', () => {
  it('has exactly the expected top-level fields (update this test when the schema changes)', () => {
    const fields = new Set(Object.keys(createTaskInputSchema.shape));

    // CLI-mapped fields
    const CLI_MAPPED = [
      'title',
      'description',
      'repo_path',
      'initial_prompt',
      'branch',
      'base_branch',
      'run_mode',
      'worktree_path',
      'model',
      'notify_task',
    ] as const;
    for (const f of CLI_MAPPED) expect(fields.has(f), `schema must have field ${f}`).toBe(true);

    // Orchestrator-only extensions
    const ORCHESTRATOR_ONLY = ['kind', 'effort', 'conversation_id'] as const;
    for (const f of ORCHESTRATOR_ONLY)
      expect(fields.has(f), `schema must have field ${f}`).toBe(true);

    // Exact count — prevents silent accidental additions
    expect(fields.size).toBe(CLI_MAPPED.length + ORCHESTRATOR_ONLY.length);
  });
});
