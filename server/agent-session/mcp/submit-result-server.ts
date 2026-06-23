/**
 * server/agent-session/mcp/submit-result-server.ts
 *
 * Generic, DB-free, standalone stdio MCP server that exposes a single
 * `submit_result` tool whose argument schema is provided by the caller at
 * startup via an environment variable. The model must call the tool; if it
 * supplies args that fail JSON-Schema validation the call is rejected with an
 * `isError` response so the model retries.
 *
 * Three pure, testable helpers:
 *   buildToolDefinition   – constructs the tool descriptor for ListTools
 *   handleSubmitResultCall – validates + dispatches; does NOT touch stdio
 *   createSubmitResultServer – wires the helpers into a low-level SDK Server
 *
 * The `main()` function (guarded by `isMainModule()`) reads env vars and
 * connects a StdioServerTransport. STDOUT is the MCP protocol channel — all
 * logging uses process.stderr.write() only.
 */

import { fileURLToPath } from 'url';
import fs from 'fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SubmitResultCallResult {
  isError: boolean;
  text: string;
}

export interface CreateSubmitResultServerOpts {
  /** JSON Schema against which the model's call args are validated. */
  schema: object;
  /** Called when valid args are received. May be async. */
  onResult: (result: unknown) => void | Promise<void>;
  /** Tool name exposed to the model. Defaults to 'submit_result'. */
  toolName?: string;
  /** Tool description. Defaults to a sensible explanation. */
  toolDescription?: string;
}

// ─── Pure helpers (testable without a subprocess) ────────────────────────────

/**
 * Build the tool descriptor returned by the ListTools handler.
 * The raw JSON Schema is passed through verbatim as `inputSchema` — the
 * low-level SDK Server does not coerce it through Zod.
 */
export function buildToolDefinition(
  schema: object,
  name: string,
  description: string,
): { name: string; description: string; inputSchema: object } {
  return { name, description, inputSchema: schema };
}

/**
 * Validate `args` against `schema` with AJV.
 * - Valid → call `onResult(args)` and return `{ isError: false, text: 'Result accepted.' }`.
 * - Invalid → return `{ isError: true, text: … }` WITHOUT calling `onResult`.
 *   The `isError` response causes the model to see a tool error and retry.
 */
export async function handleSubmitResultCall(
  schema: object,
  args: unknown,
  name: string,
  onResult: (result: unknown) => void | Promise<void>,
): Promise<SubmitResultCallResult> {
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);
  const valid = validate(args);

  if (!valid) {
    const errText = ajv.errorsText(validate.errors);
    return {
      isError: true,
      text: `Invalid arguments: ${errText}. Please correct and call ${name} again.`,
    };
  }

  await onResult(args);
  return { isError: false, text: 'Result accepted.' };
}

// ─── Server factory ───────────────────────────────────────────────────────────

const DEFAULT_TOOL_NAME = 'submit_result';
const DEFAULT_TOOL_DESCRIPTION =
  'Call this tool exactly once with your final structured result. ' +
  'The arguments must match the required schema; invalid arguments will be ' +
  'rejected and you must correct them before calling again.';

/**
 * Create and configure the low-level MCP Server with a single `submit_result`
 * tool (or whatever toolName is provided). The Server is returned but NOT yet
 * connected to any transport — call `server.connect(transport)` yourself.
 */
export function createSubmitResultServer(opts: CreateSubmitResultServerOpts): Server {
  const { schema, onResult } = opts;
  const toolName = opts.toolName ?? DEFAULT_TOOL_NAME;
  const toolDescription = opts.toolDescription ?? DEFAULT_TOOL_DESCRIPTION;

  const server = new Server(
    { name: 'octomux-submit-result', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  // ListTools → return the single tool descriptor
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [buildToolDefinition(schema, toolName, toolDescription)],
    };
  });

  // CallTool → delegate to pure helper
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== toolName) {
      return {
        content: [{ type: 'text' as const, text: `Unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }

    const result = await handleSubmitResultCall(
      schema,
      req.params.arguments ?? {},
      toolName,
      onResult,
    );

    return {
      content: [{ type: 'text' as const, text: result.text }],
      isError: result.isError,
    };
  });

  return server;
}

// ─── Entrypoint (launched as --mcp-config subprocess) ────────────────────────

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === entry;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  // Resolve schema — prefer inline JSON, fall back to a file path
  const schemaInline = process.env.OCTOMUX_SUBMIT_RESULT_SCHEMA;
  const schemaPath = process.env.OCTOMUX_SUBMIT_RESULT_SCHEMA_PATH;
  const resultPath = process.env.OCTOMUX_SUBMIT_RESULT_PATH;

  if (!resultPath) {
    process.stderr.write('octomux-submit-result: OCTOMUX_SUBMIT_RESULT_PATH is required\n');
    process.exit(1);
  }

  let schema: object;
  if (schemaInline) {
    try {
      schema = JSON.parse(schemaInline) as object;
    } catch (err) {
      process.stderr.write(
        `octomux-submit-result: failed to parse OCTOMUX_SUBMIT_RESULT_SCHEMA: ${err}\n`,
      );
      process.exit(1);
    }
  } else if (schemaPath) {
    try {
      schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as object;
    } catch (err) {
      process.stderr.write(
        `octomux-submit-result: failed to read schema from ${schemaPath}: ${err}\n`,
      );
      process.exit(1);
    }
  } else {
    process.stderr.write(
      'octomux-submit-result: one of OCTOMUX_SUBMIT_RESULT_SCHEMA or OCTOMUX_SUBMIT_RESULT_SCHEMA_PATH is required\n',
    );
    process.exit(1);
  }

  const onResult = (r: unknown): void => {
    fs.writeFileSync(resultPath, JSON.stringify(r, null, 2));
  };

  const server = createSubmitResultServer({ schema, onResult });
  const transport = new StdioServerTransport();

  process.stderr.write('octomux-submit-result: MCP server starting (stdio)\n');
  await server.connect(transport);
  process.stderr.write('octomux-submit-result: MCP server connected to stdio\n');
}

if (isMainModule()) {
  main().catch((err) => {
    // Use stderr only — stdout is the MCP protocol channel
    process.stderr.write(`octomux-submit-result: fatal error: ${err}\n`);
    process.exit(1);
  });
}
