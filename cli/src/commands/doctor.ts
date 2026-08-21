import fs from 'fs';
import chalk from 'chalk';
import { Command } from 'commander';
import { pluginReportPath } from '../../../server/plugins/paths.js';
import { buildCatalog } from '../../../server/plugins/catalog.js';
import { getContext } from '../action.js';
import { heading, label, outputJson } from '../format.js';
import type { LoadReport } from '@octomux/plugin-api';

// A `failed[].error` string comes straight from a plugin's own thrown Error —
// fully attacker-controlled. Printed raw through chalk it could repaint the
// terminal diagnosing it (cursor moves, screen clears, faked output). Strip
// C0/DEL control bytes (keep \n so multi-line messages still read) before any
// plugin-controlled text reaches the console.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g;
function sanitize(text: string): string {
  return text.replace(CONTROL_CHARS_RE, '');
}

// `CatalogEntry.provides` entries are `<category>:<rest>` — 'route:GET /x/:id',
// 'workflow:demo:changelog', 'ui:task.panel', etc. Only the counts per
// category are printed, never the raw entries, so nothing plugin-controlled
// (a route path, say) reaches the console here.
const PROVIDES_ORDER = ['workflow', 'harness', 'integration', 'route', 'ui', 'fact'] as const;
const PROVIDES_LABELS: Record<(typeof PROVIDES_ORDER)[number], [string, string]> = {
  workflow: ['workflow', 'workflows'],
  harness: ['harness', 'harnesses'],
  integration: ['integration', 'integrations'],
  route: ['route', 'routes'],
  ui: ['panel', 'panels'],
  fact: ['fact', 'facts'],
};

/** Short summary suffix like ` — 2 routes, 1 workflow, 1 panel`. Empty string
 *  (no suffix at all) when `provides` is absent or empty — an older
 *  persisted report, pre-SHR-268, must not read as "0 of everything". */
function providesSuffix(provides: string[] | undefined): string {
  if (!provides || provides.length === 0) return '';
  const counts = new Map<string, number>();
  for (const entry of provides) {
    const category = entry.split(':', 1)[0];
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const category of PROVIDES_ORDER) {
    const n = counts.get(category);
    if (!n) continue;
    const [singular, plural] = PROVIDES_LABELS[category];
    parts.push(`${n} ${n === 1 ? singular : plural}`);
  }
  return parts.length > 0 ? ` — ${parts.join(', ')}` : '';
}

type ReadResult =
  | { status: 'missing' }
  | { status: 'corrupt'; error: string }
  | { status: 'ok'; report: LoadReport; mtime: Date };

/** Distinguishes "no report has ever been persisted" (fresh install, fine)
 * from "a report exists but isn't valid JSON" (boot died mid-write — a real
 * signal, not silence) instead of collapsing both into one bare catch. */
function readReport(): ReadResult {
  const file = pluginReportPath();
  let raw: string;
  let mtime: Date;
  try {
    mtime = fs.statSync(file).mtime;
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'missing' };
    }
    return { status: 'corrupt', error: err instanceof Error ? err.message : String(err) };
  }

  try {
    return { status: 'ok', report: JSON.parse(raw) as LoadReport, mtime };
  } catch (err) {
    return { status: 'corrupt', error: err instanceof Error ? err.message : String(err) };
  }
}

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description(
      'Report plugin boot health from the last persisted load report (no server required)',
    )
    .action((_opts, cmd: Command) => {
      const { json } = getContext(cmd);
      const result = readReport();
      const reportPath = pluginReportPath();

      if (result.status === 'missing') {
        if (json) {
          outputJson({ reportPath, report: null });
          return;
        }
        console.log(`No plugin load report at ${reportPath} yet — start octomux at least once.`);
        return;
      }

      if (result.status === 'corrupt') {
        const error = sanitize(result.error);
        if (json) {
          outputJson({ reportPath, report: null, corrupt: true, error });
          return;
        }
        heading('octomux doctor');
        console.log(chalk.bold.red('✗ Report file exists but is not valid JSON'));
        console.log(label('Report file', reportPath));
        console.log(label('Parse error', error));
        console.log(
          chalk.dim('This usually means a boot died mid-write. Restart octomux to regenerate it.'),
        );
        return;
      }

      const { report, mtime } = result;

      if (json) {
        outputJson({ reportPath, report });
        return;
      }

      heading('octomux doctor');

      // A manifest parse failure means Loaded/Failed below are both empty
      // for the wrong reason — nothing ran, not "nothing to report". Lead
      // with that instead of burying it as another line among many.
      if (report.manifestError) {
        console.log(chalk.bold.red('✗ Manifest failed to parse — no plugins were loaded'));
        console.log(label('Manifest error', sanitize(report.manifestError)));
        console.log('');
      }

      console.log(label('Manifest', report.manifestPath));
      console.log(label('Safe mode', report.safeMode ? 'ON — plugin rows skipped' : 'off'));
      console.log(label('Report file', reportPath));
      console.log(
        label('Report generated', report.loadedAt ?? chalk.dim('unknown (older report)')),
      );
      console.log(label('Report file last modified', mtime.toISOString()));
      console.log('');

      console.log(chalk.bold(`Loaded (${report.loaded.length})`));
      if (report.loaded.length === 0) {
        console.log(chalk.dim('  none'));
      } else {
        const catalogById = new Map(buildCatalog(report).map((entry) => [entry.id, entry]));
        for (const p of report.loaded) {
          const suffix = providesSuffix(catalogById.get(p.id)?.provides);
          console.log(
            `  ${chalk.green('✓')} ${p.id} (${p.name}@${p.version}) — ${p.applyMs.toFixed(1)}ms${suffix}`,
          );
        }
      }

      console.log('');
      console.log(chalk.bold(`Failed (${report.failed.length})`));
      if (report.failed.length === 0) {
        console.log(chalk.dim('  none'));
      } else {
        for (const f of report.failed) {
          console.log(
            `  ${chalk.red('✗')} ${f.id} (${f.name}) [${f.phase}] — ${sanitize(f.error)}`,
          );
        }
      }
    });
}
