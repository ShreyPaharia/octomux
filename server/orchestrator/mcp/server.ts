/**
 * server/orchestrator/mcp/server.ts
 *
 * Octomux orchestrator MCP server (Task 1.5 / SHR-121).
 *
 * Exposes typed READ tools to the conductor `claude` session:
 *   list_tasks      — lean task summaries (id/title/statuses only)
 *   get_task        — lean task detail + agent_count
 *   monitor_status  — cross-task rollup + needs_attention list
 *   get_task_output — artifact pointers from managed_tasks (plan/diff_url/tests)
 *
 * All tools are **read-only**. Write actions go through the Bash tool +
 * PreToolUse gate (§5 of the spec). The server runs over stdio so it can be
 * launched as an `--mcp-config` server by the orchestrator process.
 *
 * Usage (launched by the harness via --mcp-config):
 *   node dist-server/orchestrator/mcp/server.js
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { childLogger } from '../../logger.js';
import {
  handleListTasks,
  handleGetTask,
  handleMonitorStatus,
  handleGetTaskOutput,
} from './read.js';

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

  return server;
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

// Run main when executed directly
main().catch((err) => {
  // Use stderr to avoid corrupting the stdio MCP protocol stream
  process.stderr.write(`octomux MCP server fatal error: ${err}\n`);
  process.exit(1);
});
