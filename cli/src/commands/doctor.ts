import fs from 'fs';
import chalk from 'chalk';
import { Command } from 'commander';
import { pluginReportPath } from '../../../server/plugins/paths.js';
import { getContext } from '../action.js';
import { heading, label, outputJson } from '../format.js';
import type { LoadReport } from '@octomux/plugin-api';

/**
 * `@octomux/plugin-api`'s `LoadReport` is gaining `manifestError?: string`
 * and `loadedAt: string` (a sibling change, not landed yet) so `doctor` can
 * tell "manifest failed to parse, nothing loaded" apart from "cleanly loaded
 * zero plugins". Declared locally so this file type-checks against the shape
 * doctor needs today; once the upstream type lands this becomes a no-op
 * (still-correct) intersection and can be dropped.
 *
 * `routeCounts` (SHR-253, keyed by plugin id) is the same story: `LoadReport`
 * is pinned and off-limits (plugin-api types only), and the write side —
 * snapshotting `pluginRouteCounts()` from `server/plugins/http-registry.ts`
 * into the persisted report — has to happen in `server/index.ts` right after
 * `loadPlugins()` resolves, which is outside this task's owned files (that
 * boot-sequencing wiring is SHR-254/lifecycle territory). Declared here so
 * rendering is ready the moment a report actually carries the field; until
 * then every report reads as `routeCounts: undefined` and the per-plugin
 * line below simply omits the route count.
 */
type LoadReportWithMeta = LoadReport & {
  manifestError?: string;
  loadedAt?: string;
  routeCounts?: Record<string, number>;
};

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

type ReadResult =
  | { status: 'missing' }
  | { status: 'corrupt'; error: string }
  | { status: 'ok'; report: LoadReportWithMeta; mtime: Date };

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
    return { status: 'ok', report: JSON.parse(raw) as LoadReportWithMeta, mtime };
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
        for (const p of report.loaded) {
          const routeCount = report.routeCounts?.[p.id];
          const routesSuffix =
            routeCount === undefined ? '' : ` — ${routeCount} route${routeCount === 1 ? '' : 's'}`;
          console.log(
            `  ${chalk.green('✓')} ${p.id} (${p.name}@${p.version}) — ${p.applyMs.toFixed(1)}ms${routesSuffix}`,
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
