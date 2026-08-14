import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { z } from 'zod';
import { defineCapability, resetRegistry } from '../index.js';
import type { Capability } from '../types.js';
import { registerCapabilityCommands } from './cli.js';

function cap(over: Partial<Capability> = {}): Capability {
  return {
    id: 'task.create',
    summary: 'Create a task',
    cli: 'task create',
    http: { method: 'post', path: '/api/tasks' },
    tier: 'ask',
    callers: ['ui', 'human', 'agent'],
    input: z.object({
      title: z.string().describe('Short task title'),
      repo_path: z.string().optional().describe('Absolute path to the repository'),
    }),
    handler: () => ({ ok: true }),
    ...over,
  } as Capability;
}

/** Fresh program with the same globals `cli/src/index.ts` registers before dispatch. */
function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  program.option('-s, --server-url <url>', 'server URL', 'http://localhost:7777');
  program.option('--json', 'output as JSON');
  return program;
}

function findCommand(program: Command, ...path: string[]): Command | undefined {
  let current: Command | undefined = program;
  for (const part of path) {
    current = current?.commands.find((c) => c.name() === part);
    if (!current) return undefined;
  }
  return current;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  resetRegistry();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('registerCapabilityCommands — command tree', () => {
  it('builds a noun group with a verb subcommand from cap.cli', () => {
    defineCapability(cap());
    const program = buildProgram();
    registerCapabilityCommands(program);

    const task = findCommand(program, 'task');
    expect(task, 'noun group "task" must exist').toBeDefined();
    expect(findCommand(program, 'task', 'create')).toBeDefined();
  });

  it('creates each noun group once and reuses it across capabilities', () => {
    defineCapability(cap({ id: 'task.create', cli: 'task create' }));
    defineCapability(
      cap({
        id: 'task.close',
        cli: 'task close',
        http: { method: 'post', path: '/api/tasks/:id/close' },
        input: z.object({ task_id: z.string().describe('The octomux task id') }),
      }),
    );
    const program = buildProgram();
    registerCapabilityCommands(program);

    const taskGroups = program.commands.filter((c) => c.name() === 'task');
    expect(taskGroups).toHaveLength(1);
    expect(findCommand(program, 'task', 'create')).toBeDefined();
    expect(findCommand(program, 'task', 'close')).toBeDefined();
  });

  it('ignores capabilities with no cli projection', () => {
    defineCapability(cap({ id: 'task.create', cli: 'task create' }));
    defineCapability(
      cap({ id: 'task.internal', cli: undefined, http: { method: 'post', path: '/api/internal' } }),
    );
    const program = buildProgram();
    expect(() => registerCapabilityCommands(program)).not.toThrow();
    expect(program.commands.filter((c) => c.name() === 'task')).toHaveLength(1);
  });

  it('throws when a cli capability has no http projection to call', () => {
    defineCapability(cap({ http: undefined }));
    const program = buildProgram();
    expect(() => registerCapabilityCommands(program)).toThrow(/no http projection/);
  });

  it("throws when cap.cli is not 'noun verb'", () => {
    defineCapability(cap({ cli: 'create' }));
    const program = buildProgram();
    expect(() => registerCapabilityCommands(program)).toThrow(/must be 'noun verb'/);
  });
});

describe('registerCapabilityCommands — flags derived from the zod schema', () => {
  it('maps snake_case schema fields to kebab-case flags', () => {
    defineCapability(cap());
    const program = buildProgram();
    registerCapabilityCommands(program);

    const create = findCommand(program, 'task', 'create')!;
    const flagNames = create.options.map((o) => o.long);
    expect(flagNames).toEqual(expect.arrayContaining(['--title', '--repo-path']));
  });

  it.each([
    ['title', true],
    ['repo_path', false],
  ])('field %s required=%s becomes a matching commander option', (field, required) => {
    defineCapability(cap());
    const program = buildProgram();
    registerCapabilityCommands(program);

    const create = findCommand(program, 'task', 'create')!;
    const opt = create.options.find((o) => o.long === `--${field.replace(/_/g, '-')}`)!;
    // Option.mandatory: whether the option itself must be supplied. (Option.required
    // means something different in commander — whether the flag takes a value.)
    expect(opt.mandatory).toBe(required);
  });

  it('uses the schema field .describe() text as the flag description', () => {
    defineCapability(cap());
    const program = buildProgram();
    registerCapabilityCommands(program);

    const create = findCommand(program, 'task', 'create')!;
    const opt = create.options.find((o) => o.long === '--title')!;
    expect(opt.description).toBe('Short task title');
  });

  it('renders booleans as bare flags with no value', () => {
    defineCapability(
      cap({
        input: z.object({
          task_id: z.string().describe('id'),
          draft: z.boolean().optional().describe('create as draft'),
        }),
      }),
    );
    const program = buildProgram();
    registerCapabilityCommands(program);

    const create = findCommand(program, 'task', 'create')!;
    const opt = create.options.find((o) => o.long === '--draft')!;
    expect(opt.required).toBe(false);
    expect(opt.optional).toBe(false); // bare flag: no value consumed at all
    expect(create.parseOptions(['--draft']).unknown).toEqual([]);
  });

  it.each([
    ['z.string()', z.string()],
    ['z.number()', z.number()],
    ['z.enum()', z.enum(['a', 'b'])],
  ] as const)('supports %s fields as valued flags', (_label, fieldSchema) => {
    defineCapability(
      cap({
        input: z.object({ title: z.string().describe('t'), value: fieldSchema.describe('v') }),
      }),
    );
    const program = buildProgram();
    registerCapabilityCommands(program);
    const create = findCommand(program, 'task', 'create')!;
    expect(create.options.find((o) => o.long === '--value')).toBeDefined();
  });

  it.each([
    ['array', z.array(z.string())],
    ['nested object', z.object({ nested: z.string() })],
    ['union', z.union([z.string(), z.number()])],
    ['record', z.record(z.string())],
  ])('throws for an unmappable zod construct (%s)', (_label, fieldSchema) => {
    defineCapability(
      cap({
        input: z.object({ title: z.string().describe('t'), odd: fieldSchema }),
      }),
    );
    const program = buildProgram();
    let error: Error | undefined;
    try {
      registerCapabilityCommands(program);
    } catch (e) {
      error = e as Error;
    }
    expect(error?.message).toMatch(/unsupported zod type/);
    expect(error?.message).toMatch(/'odd'/);
  });

  it('throws when cap.input is not a z.object()', () => {
    defineCapability(cap({ input: z.string() }));
    const program = buildProgram();
    expect(() => registerCapabilityCommands(program)).toThrow(/must be a z\.object\(\)/);
  });
});

describe('the whole point: a schema field automatically gains a flag — no drift possible', () => {
  it('a capability whose schema gains a field gains the flag with no CLI code change', () => {
    const schemaV1 = z.object({ title: z.string().describe('Short task title') });
    defineCapability(cap({ input: schemaV1 }));
    const programV1 = buildProgram();
    registerCapabilityCommands(programV1);
    const flagsV1 = findCommand(programV1, 'task', 'create')!.options.map((o) => o.long);
    expect(flagsV1).not.toContain('--notify-task');

    resetRegistry();

    const schemaV2 = schemaV1.extend({
      notify_task: z.string().optional().describe('Task ID to notify when this task finishes'),
    });
    defineCapability(cap({ input: schemaV2 }));
    const programV2 = buildProgram();
    registerCapabilityCommands(programV2);
    const create2 = findCommand(programV2, 'task', 'create')!;
    const flagsV2 = create2.options.map((o) => o.long);

    expect(flagsV2).toContain('--notify-task');
    const opt = create2.options.find((o) => o.long === '--notify-task')!;
    expect(opt.description).toBe('Task ID to notify when this task finishes');
    expect(opt.mandatory).toBe(false);
  });
});

describe('registerCapabilityCommands — cliAliases', () => {
  it('registers the first alias as a hidden top-level command', () => {
    defineCapability(cap({ cliAliases: ['create-task'] }));
    const program = buildProgram();
    registerCapabilityCommands(program);

    const alias = findCommand(program, 'create-task');
    expect(
      alias,
      'top-level alias must be reachable directly, not nested under task',
    ).toBeDefined();
    expect(program.helpInformation()).not.toContain('create-task');
  });

  it('registers additional aliases via commander .alias()', () => {
    defineCapability(cap({ cliAliases: ['create-task', 'new-task'] }));
    const program = buildProgram();
    registerCapabilityCommands(program);

    const alias = findCommand(program, 'create-task')!;
    expect(alias.aliases()).toContain('new-task');
  });

  it('gives the alias the same flags as the canonical command', () => {
    defineCapability(cap({ cliAliases: ['create-task'] }));
    const program = buildProgram();
    registerCapabilityCommands(program);

    const canonical = findCommand(program, 'task', 'create')!;
    const alias = findCommand(program, 'create-task')!;
    expect(alias.options.map((o) => o.long).sort()).toEqual(
      canonical.options.map((o) => o.long).sort(),
    );
  });

  it('never removes an alias even when unused elsewhere (permanence contract)', () => {
    // cliAliases is intentionally the only place third-party prompts are served from;
    // this test documents that omitting it is not an option for existing capabilities.
    defineCapability(cap({ cliAliases: ['create-task'] }));
    const program = buildProgram();
    registerCapabilityCommands(program);
    expect(findCommand(program, 'create-task')).toBeDefined();
  });
});

describe('registerCapabilityCommands — cliEnvDefaults', () => {
  // Lets an agent run `octomux task rename --title "…"` inside its own task:
  // the id it doesn't know comes from the env octomux launched it with.
  const renameCap = (over: Partial<Capability> = {}) =>
    cap({
      id: 'task.rename',
      cli: 'task rename',
      http: { method: 'post', path: '/api/tasks/:id/rename' },
      cliEnvDefaults: { id: 'OCTOMUX_TASK_ID' },
      input: z.object({
        id: z.string().describe('The octomux task id'),
        title: z.string().describe('New task title'),
      }),
      ...over,
    } as Partial<Capability>);

  afterEach(() => {
    delete process.env.OCTOMUX_TASK_ID;
  });

  it('drops the required flag to optional and defaults it when the env var is set', () => {
    process.env.OCTOMUX_TASK_ID = 'abc123';
    defineCapability(renameCap());
    const program = buildProgram();
    registerCapabilityCommands(program);

    const leaf = findCommand(program, 'task', 'rename')!;
    const idOpt = leaf.options.find((o) => o.long === '--id')!;
    expect(idOpt.mandatory).toBe(false);
    expect(idOpt.defaultValue).toBe('abc123');
  });

  it('keeps the flag required when the env var is absent', () => {
    defineCapability(renameCap());
    const program = buildProgram();
    registerCapabilityCommands(program);

    const leaf = findCommand(program, 'task', 'rename')!;
    expect(leaf.options.find((o) => o.long === '--id')!.mandatory).toBe(true);
  });

  it('leaves fields not listed in cliEnvDefaults alone', () => {
    process.env.OCTOMUX_TASK_ID = 'abc123';
    defineCapability(renameCap());
    const program = buildProgram();
    registerCapabilityCommands(program);

    const leaf = findCommand(program, 'task', 'rename')!;
    expect(leaf.options.find((o) => o.long === '--title')!.mandatory).toBe(true);
  });
});

describe('registerCapabilityCommands — sends parsed options to the server', () => {
  it('POSTs remaining fields as a JSON body to cap.http.path', async () => {
    defineCapability(cap());
    const program = buildProgram();
    registerCapabilityCommands(program);

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'task-1' }));
    vi.stubGlobal('fetch', fetchMock);

    await program.parseAsync(['task', 'create', '--title', 'Fix bug', '--json'], { from: 'user' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:7777/api/tasks');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ title: 'Fix bug' });
  });

  it('resolves the generic :id path param from the "<noun>_id" convention', async () => {
    defineCapability(
      cap({
        id: 'task.close',
        cli: 'task close',
        http: { method: 'post', path: '/api/tasks/:id/close' },
        input: z.object({ task_id: z.string().describe('The octomux task id') }),
      }),
    );
    const program = buildProgram();
    registerCapabilityCommands(program);

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await program.parseAsync(['task', 'close', '--task-id', 'task-1', '--json'], { from: 'user' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:7777/api/tasks/task-1/close');
    // task_id was consumed by the URL — it must not also appear in the body.
    expect(init.body).toBeUndefined();
  });

  it('resolves a camelCase path param directly (:agentId -> agent_id)', async () => {
    defineCapability(
      cap({
        id: 'worker.stop',
        cli: 'worker stop',
        http: { method: 'delete', path: '/api/tasks/:id/workers/:agentId' },
        input: z.object({
          task_id: z.string().describe('task'),
          agent_id: z.string().describe('agent'),
        }),
      }),
    );
    const program = buildProgram();
    registerCapabilityCommands(program);

    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await program.parseAsync(
      ['worker', 'stop', '--task-id', 'task-1', '--agent-id', 'agent-2', '--json'],
      { from: 'user' },
    );

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:7777/api/tasks/task-1/workers/agent-2');
  });

  it('sends GET requests as a query string, not a body', async () => {
    defineCapability(
      cap({
        id: 'task.list',
        cli: 'task list',
        http: { method: 'get', path: '/api/tasks' },
        input: z.object({ repo_path: z.string().optional().describe('filter by repo') }),
      }),
    );
    const program = buildProgram();
    registerCapabilityCommands(program);

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await program.parseAsync(['task', 'list', '--repo-path', '/tmp/repo', '--json'], {
      from: 'user',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:7777/api/tasks?repo_path=%2Ftmp%2Frepo');
    expect(init?.method ?? 'GET').toBe('GET');
  });

  it('uses --server-url to build the base URL', async () => {
    defineCapability(cap());
    const program = buildProgram();
    registerCapabilityCommands(program);

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await program.parseAsync(
      ['--server-url', 'http://example.test:9999', 'task', 'create', '--title', 't', '--json'],
      { from: 'user' },
    );

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('http://example.test:9999/api/tasks');
  });
});

describe('registerCapabilityCommands — honours the global --json flag', () => {
  /**
   * Output goes through the injected `write`, not `console.*` — this module
   * lives under `server/`, where CLAUDE.md forbids console. Collecting lines
   * also beats a global spy: no cross-test leakage from a stubbed console.
   */
  function runWithCollectedOutput(argv: string[], isTTY: boolean): Promise<string[]> {
    const lines: string[] = [];
    defineCapability(cap());
    const program = buildProgram();
    registerCapabilityCommands(program, { write: (line) => lines.push(line) });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ id: 'task-1' })));

    const previousTTY = process.stdout.isTTY;
    process.stdout.isTTY = isTTY;
    return program
      .parseAsync(argv, { from: 'user' })
      .then(() => lines)
      .finally(() => {
        process.stdout.isTTY = previousTTY;
      });
  }

  it.each<[string, string[], boolean, string[]]>([
    [
      'raw JSON when --json is passed',
      ['task', 'create', '--title', 't', '--json'],
      true,
      [JSON.stringify({ id: 'task-1' }, null, 2)],
    ],
    [
      'JSON when stdout is not a TTY, even without --json',
      ['task', 'create', '--title', 't'],
      false,
      [JSON.stringify({ id: 'task-1' }, null, 2)],
    ],
    [
      'human-readable key: value lines on a TTY without --json',
      ['task', 'create', '--title', 't'],
      true,
      ['id: task-1'],
    ],
  ])('prints %s', async (_label, argv, isTTY, expected) => {
    await expect(runWithCollectedOutput(argv, isTTY)).resolves.toEqual(expected);
  });

  it('writes to stdout by default when no writer is injected', async () => {
    defineCapability(cap());
    const program = buildProgram();
    registerCapabilityCommands(program);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ id: 'task-1' })));
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await program.parseAsync(['task', 'create', '--title', 't', '--json'], { from: 'user' });
      expect(writeSpy).toHaveBeenCalledWith(`${JSON.stringify({ id: 'task-1' }, null, 2)}\n`);
    } finally {
      writeSpy.mockRestore();
    }
  });
});
