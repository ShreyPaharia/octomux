import fs from 'fs';
import chalk from 'chalk';
import { Command } from 'commander';
import { pluginReportPath } from '../../../server/plugins/paths.js';
import { getContext } from '../action.js';
import { heading, label, outputJson } from '../format.js';
import type { LoadReport } from '@octomux/plugin-api';

function readReport(): LoadReport | null {
  try {
    return JSON.parse(fs.readFileSync(pluginReportPath(), 'utf-8')) as LoadReport;
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
        outputJson({ reportPath: pluginReportPath(), report });
        return;
      }

      if (!report) {
        console.log(
          `No plugin load report at ${pluginReportPath()} yet — start octomux at least once.`,
        );
        return;
      }

      heading('octomux doctor');
      console.log(label('Manifest', report.manifestPath));
      console.log(label('Safe mode', report.safeMode ? 'ON — plugin rows skipped' : 'off'));
      console.log(label('Report file', pluginReportPath()));
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
