import fs from 'fs';
import { Command } from 'commander';
import yaml from 'js-yaml';
import { readManifest } from '../../../server/plugins/manifest.js';
import { manifestPath as defaultManifestPath } from '../../../server/plugins/paths.js';
import { getContext } from '../action.js';
import { errorMessage, outputJson, printTable, success } from '../format.js';
import type { PluginManifest } from '@octomux/plugin-api';

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
function writeManifestFile(file: string, manifest: PluginManifest): void {
  const text = yaml.dump(manifest, { noRefs: true, lineWidth: -1 });
  fs.writeFileSync(file, text, 'utf-8');
}

function readManifestOrExit(file: string): PluginManifest {
  try {
    return readManifest(file);
  } catch (err) {
    errorMessage(`Failed to read manifest at ${file}: ${(err as Error).message}`);
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

  writeManifestFile(file, manifest);
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
}
