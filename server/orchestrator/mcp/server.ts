/**
 * server/orchestrator/mcp/server.ts
 *
 * Octomux orchestrator MCP server (Task 1.5 / SHR-121; seed SHR-135).
 *
 * Exposes typed READ tools to the conductor `claude` session:
 *   list_tasks         — lean task summaries (id/title/statuses only)
 *   get_task           — lean task detail + agent_count
 *   monitor_status     — cross-task rollup + needs_attention list
 *   get_task_output    — artifact pointers from managed_tasks (plan/diff_url/tests)
 *   pull_linear_issue  — lean Linear issue summary (pointer to ticket; seed §12 Phase 4)
 *
 * All tools are **read-only**. Write actions go through the Bash tool +
 * PreToolUse gate (§5 of the spec). The server runs over stdio so it can be
 * launched as an `--mcp-config` server by the orchestrator process.
 *
 * Usage (launched by the harness via --mcp-config):
 *   node dist-server/orchestrator/mcp/server.js
 */

import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { childLogger } from '../../logger.js';
import {
  handleListTasks,
  handleGetTask,
  handleMonitorStatus,
  handleGetTaskOutput,
  handleRecentRepos,
  handleDefaultBranch,
} from './read.js';
import { handlePullLinearIssue } from './seed.js';
import { callOrchestratorAction, orchestratorWriteEnabled } from './write.js';

const logger = childLogger('orchestrator/mcp/server');

// ─── Server factory ───────────────────────────────────────────────────────────

/**
 * Create and configure the octomux MCP server with all read tools.
 * Returns the McpServer instance (not yet connected to a transport).
 */
export function createOctomuxMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'octomux', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  // ── list_tasks ──────────────────────────────────────────────────────────────
  server.registerTool(
    'list_tasks',
    {
      description:
        'List octomux tasks as lean summaries (id, title, runtime_state, workflow_status). ' +
        'Optionally filter by workflow_status. Never returns description or file contents.',
      inputSchema: {
        workflow_status: z
          .string()
          .optional()
          .describe('Filter by workflow status (e.g. in_progress, backlog, done, pr)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe('Maximum number of tasks to return (default 50)'),
      },
    },
    (args) => {
      logger.debug({ operation: 'list_tasks', args }, 'MCP list_tasks invoked');
      const tasks = handleListTasks(args);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(tasks, null, 2),
          },
        ],
      };
    },
  );

  // ── get_task ────────────────────────────────────────────────────────────────
  server.registerTool(
    'get_task',
    {
      description:
        'Get a lean summary of a specific task by id. ' +
        'Returns id, title, statuses, timestamps, and agent_count (not agent rows). ' +
        'Returns null if task not found.',
      inputSchema: {
        task_id: z.string().describe('The octomux task id'),
      },
    },
    (args) => {
      logger.debug({ operation: 'get_task', task_id: args.task_id }, 'MCP get_task invoked');
      const task = handleGetTask(args);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(task, null, 2),
          },
        ],
      };
    },
  );

  // ── monitor_status ──────────────────────────────────────────────────────────
  server.registerTool(
    'monitor_status',
    {
      description:
        'Get a cross-task rollup: total task count, counts by runtime_state and workflow_status, ' +
        'and a needs_attention list (tasks in error state or with pending permission prompts). ' +
        'Never returns full task rows — only id, title, and reason.',
      inputSchema: {},
    },
    (_args) => {
      logger.debug({ operation: 'monitor_status' }, 'MCP monitor_status invoked');
      const status = handleMonitorStatus({});
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(status, null, 2),
          },
        ],
      };
    },
  );

  // ── get_task_output ─────────────────────────────────────────────────────────
  server.registerTool(
    'get_task_output',
    {
      description:
        'Get artifact pointers for a managed task. ' +
        'Returns {plan?, diff_url?, tests?} — file paths and URLs only, NEVER file contents. ' +
        'The UI fetches contents via GET /api/orchestrator/artifact; the orchestrator holds the pointer.',
      inputSchema: {
        task_id: z.string().describe('The octomux task id'),
      },
    },
    (args) => {
      logger.debug(
        { operation: 'get_task_output', task_id: args.task_id },
        'MCP get_task_output invoked',
      );
      const pointers = handleGetTaskOutput(args);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(pointers, null, 2),
          },
        ],
      };
    },
  );

  // ── pull_linear_issue ───────────────────────────────────────────────────────
  server.registerTool(
    'pull_linear_issue',
    {
      description:
        'Fetch a Linear issue and return a lean summary (pointer to the ticket). ' +
        'Returns {id, identifier, title, url, state?, priority?, estimate?, labels?, team_key?, description_snippet?}. ' +
        'The url is the authoritative pointer to the full ticket. ' +
        'description_snippet is ≤256 chars — NEVER the full body. ' +
        'Use to seed a planning session with issue context (spec §12 Phase 4).',
      inputSchema: {
        issue_id: z.string().describe("Linear issue identifier (e.g. 'SHR-123') or UUID"),
        api_key: z.string().describe('Linear API key (bare, no Bearer prefix)'),
      },
    },
    async (args) => {
      logger.debug(
        { operation: 'pull_linear_issue', issue_id: args.issue_id },
        'MCP pull_linear_issue invoked',
      );
      const summary = await handlePullLinearIssue(args);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    },
  );

  // ── recent_repos ────────────────────────────────────────────────────────────
  server.registerTool(
    'recent_repos',
    {
      description:
        'List the 10 most-recently-used distinct git repo paths from past octomux tasks. ' +
        'Use this for discovery — never use Bash to find repos. ' +
        'Returns [{repo_path, last_used}] ordered by most-recent first.',
      inputSchema: {},
    },
    (_args) => {
      logger.debug({ operation: 'recent_repos' }, 'MCP recent_repos invoked');
      const result = handleRecentRepos();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  // ── default_branch ──────────────────────────────────────────────────────────
  server.registerTool(
    'default_branch',
    {
      description:
        'Return the default branch of a git repo (e.g. "main" or "master") by inspecting ' +
        'refs/remotes/origin/HEAD. Falls back to "main" when the remote is absent or the ' +
        'path is not a git repo. Use instead of running Bash git commands.',
      inputSchema: {
        repo_path: z.string().describe('Absolute path to the git repo'),
      },
    },
    async (args) => {
      logger.debug(
        { operation: 'default_branch', repo_path: args.repo_path },
        'MCP default_branch invoked',
      );
      const result = await handleDefaultBranch(args);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  // ── Write tools (SHR-142) ─────────────────────────────────────────────────
  // Only registered for an orchestrator-started session (base url + token in
  // env). Each RPCs to the main server, which runs the action + reports it.
  if (orchestratorWriteEnabled()) {
    registerWriteTools(server);
  }

  return server;
}

/**
 * Register the conductor's write tools. Each takes structured args (no Bash
 * string) and RPCs to the main server's orchestrator-action endpoint. The action
 * executes immediately and an activity update is pushed to the conversation —
 * there is no approval gate.
 */
function registerWriteTools(server: McpServer): void {
  const text = (v: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }],
  });

  server.registerTool(
    'create_task',
    {
      description:
        'Create an octomux worker task and start it. Pass a GOAL-ORIENTED brief in ' +
        'description (Goal / Why / verifiable Acceptance criteria / Hard constraints / ' +
        'Non-goals / Pointers) — never a step-by-step plan; the worker explores the code ' +
        'and owns the implementation. Use kind="plan" for ambiguous/larger work (the ' +
        'worker plans first for your review). Returns the task id (a pointer).',
      inputSchema: {
        title: z.string().describe('Short task title (< 60 chars)'),
        description: z
          .string()
          .describe('The goal-oriented brief (WHAT/WHY + acceptance criteria)'),
        repo_path: z.string().describe('Absolute path to the git repository'),
        base_branch: z.string().optional().describe('Base branch (default: main)'),
        branch: z.string().optional().describe('Branch name (auto-generated if omitted)'),
        kind: z.enum(['plan', 'implement']).optional().describe('"plan" → worker plans first'),
        model: z.string().optional().describe('Per-task model override (e.g. claude-sonnet-4-6)'),
      },
    },
    async (args) => text(await callOrchestratorAction('create-task', args)),
  );

  server.registerTool(
    'send_message',
    {
      description: 'Send a message/instruction to a running task’s agent (e.g. nudge or redirect).',
      inputSchema: {
        task_id: z.string().describe('The octomux task id'),
        message: z.string().describe('The message to deliver'),
      },
    },
    async (args) => text(await callOrchestratorAction('send-message', args)),
  );

  server.registerTool(
    'set_task_status',
    {
      description:
        'Set a task’s workflow status (backlog | planned | in_progress | human_review | pr | done).',
      inputSchema: {
        task_id: z.string().describe('The octomux task id'),
        status: z.string().describe('New workflow status'),
      },
    },
    async (args) => text(await callOrchestratorAction('set-status', args)),
  );

  server.registerTool(
    'add_agent',
    {
      description:
        'Attach another agent (new tmux window) to a running task, sharing its worktree.',
      inputSchema: {
        task_id: z.string().describe('The octomux task id'),
        prompt: z.string().optional().describe('Initial prompt for the new agent'),
        label: z.string().optional().describe('Label for the new agent'),
        model: z.string().optional().describe('Per-agent model override'),
      },
    },
    async (args) => text(await callOrchestratorAction('add-agent', args)),
  );

  server.registerTool(
    'close_task',
    {
      description:
        'Close a task: stop its agents + kill its tmux session. Preserves the worktree/branch ' +
        'so it can be resumed. Runs immediately (no approval).',
      inputSchema: { task_id: z.string().describe('The octomux task id') },
    },
    async (args) => text(await callOrchestratorAction('close-task', args)),
  );

  server.registerTool(
    'delete_task',
    {
      description:
        'DELETE a task: kill tmux + remove worktree + delete branch + delete DB rows. Destructive ' +
        'and irreversible. Runs immediately (no approval) — only call when the user clearly intends it.',
      inputSchema: { task_id: z.string().describe('The octomux task id') },
    },
    async (args) => text(await callOrchestratorAction('delete-task', args)),
  );
}

// ─── Entrypoint (launched as --mcp-config subprocess) ────────────────────────

/**
 * Main entrypoint: create the server and connect to stdio transport.
 * Only runs when invoked directly (not when imported as a module).
 */
async function main(): Promise<void> {
  logger.info({ operation: 'startup' }, 'octomux MCP server starting (stdio)');

  const server = createOctomuxMcpServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  logger.info({ operation: 'startup' }, 'octomux MCP server connected to stdio');
}

// Run main ONLY when executed directly (claude spawns this as an --mcp-config
// stdio subprocess). Guard against module import (e.g. the build bundling it as
// an entry, or a test importing createOctomuxMcpServer) auto-spawning a server.
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === entry;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err) => {
    // Use stderr to avoid corrupting the stdio MCP protocol stream
    process.stderr.write(`octomux MCP server fatal error: ${err}\n`);
    process.exit(1);
  });
}
