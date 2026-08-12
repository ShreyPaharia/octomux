/**
 * server/registry/projections/cli.ts
 *
 * CLI projection generator. Turns every `listCliCapabilities()` row into a
 * commander subcommand: flags are derived from `cap.input` (the zod schema),
 * so a schema field can never drift from its flag the way hand-written
 * commander definitions could — see `cli/src/commands/command-schema-drift.test.ts`,
 * which this generator makes unnecessary.
 *
 * Design doc: docs/superpowers/specs/2026-08-12-surface-consolidation-and-centaur-design.md §5.1, §5.2
 */

import { createRequestCore, qs } from '@octomux/api-client';
import { Command } from 'commander';
import { z } from 'zod';
import { listCliCapabilities } from '../index.js';
import type { Capability } from '../types.js';

// ─── zod introspection ─────────────────────────────────────────────────────────
//
// Only scalar leaf types can become a single flag. Arrays, nested objects,
// unions, records, tuples, maps and sets have no unambiguous single-flag
// representation, so they are rejected loudly at registration time rather
// than silently dropped.

/** Peels ZodOptional / ZodNullable / ZodDefault wrappers to find the base type. */
function unwrapSchema(schema: z.ZodTypeAny): { inner: z.ZodTypeAny; required: boolean } {
  let current = schema;
  let required = true;
  for (;;) {
    if (current instanceof z.ZodOptional) {
      required = false;
      current = current.unwrap();
    } else if (current instanceof z.ZodDefault) {
      required = false;
      current = current.removeDefault();
    } else if (current instanceof z.ZodNullable) {
      current = current.unwrap();
    } else {
      break;
    }
  }
  return { inner: current, required };
}

/** Finds the `.describe()` text at any layer of an optional/nullable/default chain. */
function describeField(schema: z.ZodTypeAny): string | undefined {
  if (schema.description) return schema.description;
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return describeField(schema.unwrap());
  }
  if (schema instanceof z.ZodDefault) {
    return describeField(schema.removeDefault());
  }
  return undefined;
}

function toKebabCase(snake: string): string {
  return snake.replace(/_/g, '-');
}

/** camelCase -> snake_case, e.g. `agentId` -> `agent_id`. Mirrors the CLI drift test. */
function toSnakeCase(camel: string): string {
  return camel.replace(/([A-Z])/g, (ch) => `_${ch.toLowerCase()}`);
}

/** snake_case -> camelCase, e.g. `repo_path` -> `repoPath`. Matches commander's attributeName. */
function toCamelCase(snake: string): string {
  return snake.replace(/_([a-z0-9])/g, (_all, ch: string) => ch.toUpperCase());
}

/** Adds one commander option derived from a single zod schema field. */
function addOption(cmd: Command, capId: string, fieldName: string, schema: z.ZodTypeAny): void {
  const flagName = toKebabCase(fieldName);
  const description = describeField(schema) ?? fieldName;
  const { inner, required } = unwrapSchema(schema);

  if (inner instanceof z.ZodBoolean) {
    const flags = `--${flagName}`;
    if (required) cmd.requiredOption(flags, description);
    else cmd.option(flags, description);
    return;
  }

  if (inner instanceof z.ZodNumber) {
    const flags = `--${flagName} <value>`;
    const parser = (v: string) => Number(v);
    if (required) cmd.requiredOption(flags, description, parser);
    else cmd.option(flags, description, parser);
    return;
  }

  if (
    inner instanceof z.ZodString ||
    inner instanceof z.ZodEnum ||
    inner instanceof z.ZodNativeEnum
  ) {
    const flags = `--${flagName} <value>`;
    if (required) cmd.requiredOption(flags, description);
    else cmd.option(flags, description);
    return;
  }

  throw new Error(
    `registry: capability '${capId}' field '${fieldName}' has an unsupported zod type for CLI ` +
      `flag generation (${inner.constructor.name}). Supported: string, number, boolean, enum, ` +
      'native enum (optionally wrapped in optional/nullable/default).',
  );
}

/** The zod object's field map, or throws — a capability's CLI flags must come from a flat shape. */
function objectFields(cap: Capability): Record<string, z.ZodTypeAny> {
  if (!(cap.input instanceof z.ZodObject)) {
    throw new Error(
      `registry: capability '${cap.id}' input must be a z.object() to derive CLI flags`,
    );
  }
  return cap.input.shape as Record<string, z.ZodTypeAny>;
}

/**
 * Maps each `:param` segment in an Express-style path to a schema field name.
 * Direct match first (`:agentId` -> `agent_id`); falls back to the
 * `<singular-of-preceding-segment>_id` convention this codebase uses for the
 * generic `:id` param (`/api/tasks/:id` -> `task_id`).
 */
function resolvePathParams(
  path: string,
  fields: Record<string, z.ZodTypeAny>,
  capId: string,
): Map<string, string> {
  const map = new Map<string, string>();
  const segments = path.split('/');
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (!segment.startsWith(':')) continue;
    const param = segment.slice(1);
    const direct = toSnakeCase(param);
    if (direct in fields) {
      map.set(param, direct);
      continue;
    }
    if (param === 'id') {
      const resource = segments[i - 1];
      const singular = resource?.endsWith('s') ? resource.slice(0, -1) : resource;
      const guess = singular ? `${singular}_id` : undefined;
      if (guess && guess in fields) {
        map.set(param, guess);
        continue;
      }
    }
    throw new Error(
      `registry: capability '${capId}' cannot resolve path param ':${param}' in '${path}' to an ` +
        'input field',
    );
  }
  return map;
}

function buildPath(
  pathTemplate: string,
  pathParamFields: Map<string, string>,
  opts: Record<string, unknown>,
): string {
  return pathTemplate
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment;
      const fieldName = pathParamFields.get(segment.slice(1))!;
      return encodeURIComponent(String(opts[toCamelCase(fieldName)]));
    })
    .join('/');
}

// ─── output ────────────────────────────────────────────────────────────────────

/** Mirrors `cli/src/format.ts#isJsonMode` without importing across the cli/server boundary. */
function isJsonMode(json: unknown): boolean {
  return json === true || !process.stdout.isTTY;
}

/**
 * Emits one line of CLI output. Injectable so this module never calls
 * `console.*` — CLAUDE.md forbids it under `server/`, and this is command
 * output rather than a log, so it must not go through pino either. Tests pass
 * a collector; the CLI entry point can pass its own printer.
 */
export type WriteLine = (line: string) => void;

const defaultWriteLine: WriteLine = (line) => {
  process.stdout.write(`${line}\n`);
};

function printResult(result: unknown, json: boolean, write: WriteLine): void {
  if (json || result === undefined || typeof result !== 'object' || result === null) {
    if (result !== undefined) write(JSON.stringify(result, null, 2));
    return;
  }
  for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
    write(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
  }
}

// ─── command tree ────────────────────────────────────────────────────────────

function getOrCreateGroup(
  program: Command,
  groups: Map<string, Command>,
  parts: string[],
): Command {
  let parent = program;
  let key = '';
  for (const part of parts) {
    key = key ? `${key} ${part}` : part;
    let group = groups.get(key);
    if (!group) {
      group = parent.command(part);
      groups.set(key, group);
    }
    parent = group;
  }
  return parent;
}

/** Attaches flags and the server-calling action handler to a leaf command. */
function configureLeaf(
  cmd: Command,
  cap: Capability,
  http: NonNullable<Capability['http']>,
  fields: Record<string, z.ZodTypeAny>,
  pathParamFields: Map<string, string>,
  write: WriteLine,
): void {
  cmd.description(cap.summary);
  for (const [fieldName, fieldSchema] of Object.entries(fields)) {
    addOption(cmd, cap.id, fieldName, fieldSchema);
  }

  const consumed = new Set(pathParamFields.values());

  cmd.action(async (opts: Record<string, unknown>, thisCmd: Command) => {
    const globals = thisCmd.optsWithGlobals();
    const json = isJsonMode(globals.json);
    const serverUrl =
      (globals.serverUrl as string | undefined) ||
      process.env.OCTOMUX_URL ||
      'http://localhost:7777';

    const { request } = createRequestCore({
      // cap.http.path already includes the '/api' prefix (design doc §5.1 example).
      baseUrl: serverUrl.replace(/\/$/, ''),
      alwaysJsonContentType: true,
      onFetchError: (err) => {
        const cause = (err as NodeJS.ErrnoException)?.cause as NodeJS.ErrnoException | undefined;
        if (cause?.code === 'ECONNREFUSED') {
          throw new Error(
            `Cannot connect to octomux server at ${serverUrl}\nStart it with: octomux start`,
          );
        }
        throw err;
      },
    });

    const path = buildPath(http.path, pathParamFields, opts);
    const method = http.method.toUpperCase();

    const remaining: Record<string, unknown> = {};
    for (const fieldName of Object.keys(fields)) {
      if (consumed.has(fieldName)) continue;
      const value = opts[toCamelCase(fieldName)];
      if (value !== undefined) remaining[fieldName] = value;
    }

    let result: unknown;
    if (method === 'GET') {
      const queryParams: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(remaining)) queryParams[key] = String(value);
      result = await request(path + qs(queryParams));
    } else {
      const hasBody = Object.keys(remaining).length > 0;
      result = await request(path, {
        method,
        ...(hasBody ? { body: JSON.stringify(remaining) } : {}),
      });
    }

    printResult(result, json, write);
  });
}

function registerOne(
  program: Command,
  groups: Map<string, Command>,
  cap: Capability,
  write: WriteLine,
): void {
  if (!cap.cli) return;
  if (!cap.http) {
    throw new Error(
      `registry: capability '${cap.id}' has a cli projection ('${cap.cli}') but no http ` +
        'projection for the CLI to call',
    );
  }

  const parts = cap.cli.trim().split(/\s+/);
  if (parts.length < 2) {
    throw new Error(`registry: capability '${cap.id}' cli '${cap.cli}' must be 'noun verb'`);
  }
  const leafName = parts[parts.length - 1];
  const groupParts = parts.slice(0, -1);

  const fields = objectFields(cap);
  const pathParamFields = resolvePathParams(cap.http.path, fields, cap.id);

  const group = getOrCreateGroup(program, groups, groupParts);
  const leaf = group.command(leafName);
  configureLeaf(leaf, cap, cap.http, fields, pathParamFields, write);

  // Legacy flat names (e.g. 'create-task') are permanent, hidden, top-level
  // aliases — they never move under the noun group because third-party
  // prompts and configs outside this repo depend on the flat form.
  if (cap.cliAliases && cap.cliAliases.length > 0) {
    const [primary, ...rest] = cap.cliAliases;
    const aliasCmd = program.command(primary, { hidden: true });
    for (const extra of rest) aliasCmd.alias(extra);
    configureLeaf(aliasCmd, cap, cap.http, fields, pathParamFields, write);
  }
}

/**
 * Builds the full commander tree from the capability registry. Each `cap.cli`
 * string (`'task create'`) becomes a noun group (`task`, created once and
 * reused) with a verb subcommand (`create`). Options are derived from
 * `cap.input`, so a schema change flows straight into `--help` — there is
 * nothing left to drift.
 */
export function registerCapabilityCommands(
  program: Command,
  opts: { write?: WriteLine } = {},
): void {
  const write = opts.write ?? defaultWriteLine;
  const groups = new Map<string, Command>();
  for (const cap of listCliCapabilities()) {
    registerOne(program, groups, cap, write);
  }
}
