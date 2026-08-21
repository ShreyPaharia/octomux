import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Command } from 'commander';
import yaml from 'js-yaml';
import { parseManifest, readManifest } from '../../../server/plugins/manifest.js';
import { manifestPath as defaultManifestPath } from '../../../server/plugins/paths.js';
import { getContext } from '../action.js';
import { errorMessage, outputJson, printTable, success } from '../format.js';
import type { PluginManifest, PluginRow } from '@octomux/plugin-api';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `octomux plugins list|disable|enable` edit `octomux.yml` directly and never
 * boot or contact the server — a plugin that broke boot is exactly the case
 * these need to work in.
 *
 * Writing back: `readManifest` returns validated data (every field
 * `parseManifest` allows), not a concrete syntax tree, so `yaml.dump` here
 * round-trips every value losslessly but re-serializes the whole file from
 * scratch — comments, key order, blank lines, and quote style in a
 * hand-edited manifest do not survive the first `disable`/`enable` write.
 */

/**
 * `yaml.dump` on a `config` value containing a newline followed by `&`/`*`
 * re-emits it as a YAML block scalar — legal on the way in (quoted spans get
 * blanked before `manifest.ts`'s anchor/alias scan runs), but the unquoted
 * block-scalar line the dumper produces trips that same anchor/alias guard on
 * the next `readManifest`. Once that happens `loadPlugins` loads zero plugins
 * and every `octomux plugins` subcommand exits 1 — no recovery path. So:
 * round-trip the serialized text through `parseManifest` before committing
 * the write, and refuse (naming the row) rather than write something we
 * already know we can't read back.
 */
function findOffendingRowIndex(manifest: PluginManifest): number {
  for (let i = 0; i < manifest.plugins.length; i++) {
    const single: PluginManifest = { plugins: [manifest.plugins[i]] };
    try {
      parseManifest(yaml.dump(single, { noRefs: true, lineWidth: -1 }));
    } catch {
      return i;
    }
  }
  return -1;
}

function assertRoundTrips(text: string, manifest: PluginManifest): void {
  try {
    parseManifest(text);
  } catch (err) {
    const index = findOffendingRowIndex(manifest);
    const row: PluginRow | undefined = index >= 0 ? manifest.plugins[index] : undefined;
    const where = row ? `plugins[${index}] (id "${row.id}")` : 'a plugin row';
    throw new Error(
      `refusing to write manifest: serialized YAML for ${where} would not parse back — ${errMsg(err)}`,
    );
  }
}

/** Writes `text` to `file` atomically: temp file in the same directory, then
 * `rename` over the target, so a process killed mid-write can never leave a
 * truncated or half-written manifest on disk. */
function atomicWriteFileSync(file: string, text: string): void {
  const dir = path.dirname(file);
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  fs.writeFileSync(tmp, text, 'utf-8');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

function writeManifestFile(file: string, manifest: PluginManifest): void {
  const text = yaml.dump(manifest, { noRefs: true, lineWidth: -1 });
  assertRoundTrips(text, manifest);
  atomicWriteFileSync(file, text);
}

function readManifestOrExit(file: string): PluginManifest {
  try {
    return readManifest(file);
  } catch (err) {
    errorMessage(`Failed to read manifest at ${file}: ${errMsg(err)}`);
    process.exit(1);
  }
}

function setDisabled(id: string, disabled: boolean): void {
  const file = defaultManifestPath();
  const manifest = readManifestOrExit(file);

  const row = manifest.plugins.find((p) => p.id === id);
  if (!row) {
    errorMessage(`No plugin with id "${id}" in ${file}`);
    process.exit(1);
  }

  if (disabled) {
    row.disabled = true;
  } else {
    delete row.disabled;
  }

  try {
    writeManifestFile(file, manifest);
  } catch (err) {
    errorMessage(errMsg(err));
    process.exit(1);
  }
  success(`${disabled ? 'Disabled' : 'Enabled'} plugin "${id}" in ${file}`);
}

export function registerPlugins(program: Command): void {
  const plugins = program
    .command('plugins')
    .description(
      'Manage the plugin manifest (octomux.yml) — edits the file directly, no server required',
    );

  plugins
    .command('list')
    .description('List plugins in the manifest')
    .action((_opts, cmd: Command) => {
      const { json } = getContext(cmd);
      const file = defaultManifestPath();
      const manifest = readManifestOrExit(file);

      if (json) {
        outputJson({ manifestPath: file, plugins: manifest.plugins });
        return;
      }
      if (manifest.plugins.length === 0) {
        console.log(`No plugins in manifest (${file}).`);
        return;
      }
      printTable(
        [
          { header: 'ID', width: 20, get: (p) => p.id },
          { header: 'NAME', width: 30, get: (p) => p.name },
          { header: 'VERSION', width: 12, get: (p) => p.version ?? '—' },
          { header: 'STATUS', get: (p) => (p.disabled ? 'disabled' : 'enabled') },
        ],
        manifest.plugins,
      );
    });

  plugins
    .command('disable <id>')
    .description('Disable a plugin by id')
    .action((id: string) => setDisabled(id, true));

  plugins
    .command('enable <id>')
    .description('Enable a plugin by id')
    .action((id: string) => setDisabled(id, false));

  plugins
    .command('reload <id>')
    .description(
      'Unmount and remount a running plugin (dev hot-reload) — requires a running server, ' +
        'unlike list/disable/enable',
    )
    .action(async (id: string, _opts, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const json = Boolean(globals.json);
      const serverUrl = String(
        globals.serverUrl || process.env.OCTOMUX_URL || 'http://localhost:7777',
      ).replace(/\/$/, '');

      let res: Response;
      try {
        res = await fetch(`${serverUrl}/api/plugins/${encodeURIComponent(id)}/reload`, {
          method: 'POST',
        });
      } catch {
        errorMessage(
          `Cannot connect to octomux server at ${serverUrl}\nStart it with: octomux start`,
        );
        process.exit(1);
        return;
      }

      const body: unknown = await res.json().catch(() => ({}));

      if (!res.ok || (body as { ok?: boolean }).ok !== true) {
        if (json) {
          outputJson(body);
        } else {
          const reason = (body as { reason?: string }).reason ?? `HTTP ${res.status}`;
          errorMessage(`Reload failed for plugin "${id}": ${reason}`);
        }
        process.exit(1);
        return;
      }

      if (json) {
        outputJson(body);
        return;
      }
      success(`Reloaded plugin "${id}"`);
    });
}
