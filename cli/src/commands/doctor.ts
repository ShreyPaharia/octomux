import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { Command } from 'commander';
import { octomuxRoot } from '../../../server/octomux-root.js';
import { getContext } from '../action.js';
import { heading, label, outputJson } from '../format.js';
import type { LoadReport } from '@octomux/plugin-api';

/**
 * Keep this path in sync with `pluginReportPath()` in `server/index.ts` — the
 * server persists a `LoadReport` there after every `loadPlugins()` run on
 * boot. `doctor` reads that file directly and never boots or contacts the
 * server: a plugin that broke boot is exactly the case this needs to work in.
 */
function reportPath(): string {
  return path.join(octomuxRoot(), 'plugin-load-report.json');
}

function readReport(): LoadReport | null {
  try {
    return JSON.parse(fs.readFileSync(reportPath(), 'utf-8')) as LoadReport;
  } catch {
    return null;
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
      const report = readReport();

      if (json) {
        outputJson({ reportPath: reportPath(), report });
        return;
      }

      if (!report) {
        console.log(`No plugin load report at ${reportPath()} yet — start octomux at least once.`);
        return;
      }

      heading('octomux doctor');
      console.log(label('Manifest', report.manifestPath));
      console.log(label('Safe mode', report.safeMode ? 'ON — plugin rows skipped' : 'off'));
      console.log(label('Report file', reportPath()));
      console.log('');

      console.log(chalk.bold(`Loaded (${report.loaded.length})`));
      if (report.loaded.length === 0) {
        console.log(chalk.dim('  none'));
      } else {
        for (const p of report.loaded) {
          console.log(
            `  ${chalk.green('✓')} ${p.id} (${p.name}@${p.version}) — ${p.applyMs.toFixed(1)}ms`,
          );
        }
      }

      console.log('');
      console.log(chalk.bold(`Failed (${report.failed.length})`));
      if (report.failed.length === 0) {
        console.log(chalk.dim('  none'));
      } else {
        for (const f of report.failed) {
          console.log(`  ${chalk.red('✗')} ${f.id} (${f.name}) [${f.phase}] — ${f.error}`);
        }
      }
    });
}
