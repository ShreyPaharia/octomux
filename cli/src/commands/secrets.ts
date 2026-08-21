import { Command } from 'commander';
import { errorMessage, outputJson, printTable, success } from '../format.js';

/**
 * `octomux secrets` — CLI surface for the named secret store (SHR-277).
 *
 * Talks to `/api/secrets` directly with `fetch`, not the shared `OctomuxClient`
 * (`../client.ts`) — same pattern as `plugins reload` in `./plugins.js`. There
 * is no `GET /api/secrets/:name`, so `list` can only ever print names +
 * descriptions; the server never hands back a value.
 */

interface SecretMeta {
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

function serverUrlFrom(cmd: Command): string {
  const globals = cmd.optsWithGlobals();
  return String(globals.serverUrl || process.env.OCTOMUX_URL || 'http://localhost:7777').replace(
    /\/$/,
    '',
  );
}

function jsonModeFrom(cmd: Command): boolean {
  const globals = cmd.optsWithGlobals();
  return Boolean(globals.json) || !process.stdout.isTTY;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks)
    .toString('utf-8')
    .replace(/\r?\n$/, '');
}

async function apiFetch(
  serverUrl: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await fetch(`${serverUrl}/api/secrets${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    errorMessage(`Cannot connect to octomux server at ${serverUrl}\nStart it with: octomux start`);
    process.exit(1);
  }
  const body: unknown = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

export function registerSecrets(program: Command): void {
  const secrets = program
    .command('secrets')
    .description('Manage the named secret store — values are write-only, never read back');

  secrets
    .command('list')
    .description('List secret names and descriptions (values are never returned)')
    .action(async (_opts, cmd: Command) => {
      const serverUrl = serverUrlFrom(cmd);
      const json = jsonModeFrom(cmd);
      const { status, body } = await apiFetch(serverUrl, '');
      if (status !== 200) {
        errorMessage(`Failed to list secrets (HTTP ${status})`);
        process.exit(1);
        return;
      }
      const list = (body as { secrets: SecretMeta[] }).secrets;
      if (json) {
        outputJson(list);
        return;
      }
      if (list.length === 0) {
        console.log('No secrets stored.');
        return;
      }
      printTable(
        [
          { header: 'NAME', width: 24, get: (s: SecretMeta) => s.name },
          { header: 'DESCRIPTION', width: 40, get: (s: SecretMeta) => s.description ?? '—' },
          { header: 'UPDATED', get: (s: SecretMeta) => s.updated_at },
        ],
        list,
      );
    });

  secrets
    .command('set <name>')
    .description('Create or update a secret')
    .option('--value <value>', 'the secret value (prefer --stdin to avoid shell history)')
    .option(
      '--stdin',
      'read the value from stdin instead of --value — keeps it out of shell history/process list',
    )
    .option('--description <description>', 'a human-readable note about this secret')
    .action(
      async (
        name: string,
        opts: { value?: string; stdin?: boolean; description?: string },
        cmd: Command,
      ) => {
        if (Boolean(opts.value) === Boolean(opts.stdin)) {
          errorMessage('exactly one of --value or --stdin is required');
          process.exit(1);
          return;
        }
        const value = opts.stdin ? await readStdin() : opts.value!;
        if (!value) {
          errorMessage('secret value must not be empty');
          process.exit(1);
          return;
        }

        const serverUrl = serverUrlFrom(cmd);
        const json = jsonModeFrom(cmd);
        const { status, body } = await apiFetch(serverUrl, `/${encodeURIComponent(name)}`, {
          method: 'PUT',
          body: JSON.stringify({ value, description: opts.description ?? null }),
        });
        if (status !== 200) {
          const msg = (body as { error?: string }).error ?? `HTTP ${status}`;
          errorMessage(`Failed to set secret "${name}": ${msg}`);
          process.exit(1);
          return;
        }
        if (json) {
          outputJson(body);
          return;
        }
        success(`Secret "${name}" saved`);
      },
    );

  secrets
    .command('rm <name>')
    .description('Delete a secret')
    .action(async (name: string, _opts, cmd: Command) => {
      const serverUrl = serverUrlFrom(cmd);
      const json = jsonModeFrom(cmd);
      const { status, body } = await apiFetch(serverUrl, `/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
      if (status === 404) {
        errorMessage(`No secret named "${name}"`);
        process.exit(1);
        return;
      }
      if (status !== 204) {
        const msg = (body as { error?: string }).error ?? `HTTP ${status}`;
        errorMessage(`Failed to delete secret "${name}": ${msg}`);
        process.exit(1);
        return;
      }
      if (json) {
        outputJson({ deleted: true, name });
        return;
      }
      success(`Secret "${name}" deleted`);
    });
}
