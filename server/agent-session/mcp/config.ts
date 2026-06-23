/**
 * server/agent-session/mcp/config.ts
 *
 * Helpers for resolving the submit-result MCP server invocation and writing
 * per-run mcp-config.json files. Mirrors the pattern in
 * server/orchestrator/runner.ts (`mcpServerInvocation`) and
 * server/task-engine/launch.ts (`writeWorkerMcpConfig`).
 *
 * DB-free — no imports from db/repositories/task-runner/task-engine/orchestrator.
 */

import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';

// ─── Invocation resolver ─────────────────────────────────────────────────────

/**
 * Resolve how to launch the submit-result stdio MCP server.
 *
 * - prod: `dist-server/agent-session/mcp/submit-result-server.js`
 *   (emitted by the `--entry.agent-session/mcp/submit-result-server` tsup entry)
 * - dev:  `server/agent-session/mcp/submit-result-server.ts`
 *   (run via tsx so TypeScript executes without a build step)
 *
 * Returns null if neither candidate exists.
 */
export function submitResultServerInvocation(): { command: string; args: string[] } | null {
  const here = fileURLToPath(import.meta.url);
  const dir = path.dirname(here);

  // prod: this file lives in dist-server/agent-session/mcp/config.js → server.js sibling
  const prodServer = path.join(dir, 'submit-result-server.js');
  if (fs.existsSync(prodServer)) {
    return { command: process.execPath, args: [prodServer] };
  }

  // dev: this file lives in server/agent-session/mcp/config.ts → server.ts sibling
  const devServer = path.join(dir, 'submit-result-server.ts');
  if (fs.existsSync(devServer)) {
    try {
      const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
      return { command: process.execPath, args: [tsxCli, devServer] };
    } catch {
      return null;
    }
  }

  return null;
}

// ─── Config file writer ──────────────────────────────────────────────────────

export interface WriteSubmitResultMcpConfigOpts {
  /** JSON Schema the model's call args must satisfy. */
  schema: object;
  /** Absolute path where the captured result JSON will be written. */
  resultPath: string;
  /** Name used as the mcpServers key. Defaults to 'submit_result'. */
  serverName?: string;
}

/**
 * Write an mcp-config.json for the submit-result server into `dir`.
 *
 * The config follows the standard MCP stdio format:
 *   { mcpServers: { <serverName>: { command, args, env } } }
 *
 * The server reads:
 *   OCTOMUX_SUBMIT_RESULT_SCHEMA  — inline JSON of the schema
 *   OCTOMUX_SUBMIT_RESULT_PATH    — path to write the captured result
 *
 * Returns the absolute path to the written config file, or null when the
 * server invocation cannot be resolved (caller proceeds without MCP).
 */
export function writeSubmitResultMcpConfig(
  dir: string,
  opts: WriteSubmitResultMcpConfigOpts,
): string | null {
  const inv = submitResultServerInvocation();
  if (!inv) return null;

  const serverName = opts.serverName ?? 'submit_result';

  fs.mkdirSync(dir, { recursive: true });

  const env: Record<string, string> = {
    OCTOMUX_SUBMIT_RESULT_SCHEMA: JSON.stringify(opts.schema),
    OCTOMUX_SUBMIT_RESULT_PATH: opts.resultPath,
  };
  if (process.env.NODE_ENV) env.NODE_ENV = process.env.NODE_ENV;
  if (process.env.OCTOMUX_DATA_DIR) env.OCTOMUX_DATA_DIR = process.env.OCTOMUX_DATA_DIR;

  const cfg = {
    mcpServers: {
      [serverName]: {
        command: inv.command,
        args: inv.args,
        env,
      },
    },
  };

  const cfgPath = path.join(dir, 'submit-result-mcp-config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');

  return cfgPath;
}
