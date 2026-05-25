import { Command } from 'commander';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';
import chalk from 'chalk';
import { success, errorMessage } from '../format.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveTemplateDir(): string {
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'hooks'),
    path.resolve(__dirname, '..', '..', '..', 'templates', 'hooks'),
    path.resolve(__dirname, '..', '..', 'templates', 'hooks'),
    path.resolve(__dirname, '..', 'templates', 'hooks'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

interface TemplateManifest {
  event: string;
  files: string[];
}

function listAvailableTemplates(templatesBase: string): string[] {
  try {
    if (!fs.existsSync(templatesBase)) return [];
    return fs.readdirSync(templatesBase).filter((f) => {
      try {
        return fs.statSync(path.join(templatesBase, f)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

export function registerHooksInstall(program: Command): void {
  program
    .command('hooks-install <template>')
    .description(
      'Install a hook template into ~/.octomux/hooks/<event>.d/. ' +
        'Available templates: jira-status',
    )
    .option('-d, --hooks-dir <dir>', 'override hooks base directory (default: ~/.octomux/hooks)')
    .action(async (template: string, opts: { hooksDir?: string }) => {
      const templatesBase = resolveTemplateDir();
      const templateDir = path.join(templatesBase, template);

      if (!fs.existsSync(templateDir)) {
        errorMessage(
          `Template "${template}" not found. ` +
            `Expected directory at ${templateDir}\n` +
            `Available templates: ${listAvailableTemplates(templatesBase).join(', ')}`,
        );
        process.exit(1);
      }

      const manifestPath = path.join(templateDir, 'template.json');
      if (!fs.existsSync(manifestPath)) {
        errorMessage(`template.json not found in ${templateDir}`);
        process.exit(1);
      }

      let manifest: TemplateManifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as TemplateManifest;
      } catch (err) {
        errorMessage(`Failed to parse template.json: ${(err as Error).message}`);
        process.exit(1);
      }

      const hooksBase = opts.hooksDir ?? path.join(os.homedir(), '.octomux', 'hooks');
      const targetDir = path.join(hooksBase, `${manifest.event}.d`);

      fs.mkdirSync(targetDir, { recursive: true });

      const installed: string[] = [];
      for (const fileName of manifest.files) {
        const src = path.join(templateDir, fileName);
        const dest = path.join(targetDir, fileName);

        if (!fs.existsSync(src)) {
          errorMessage(`Template file not found: ${src}`);
          process.exit(1);
        }

        fs.copyFileSync(src, dest);

        if (!fileName.endsWith('.json')) {
          fs.chmodSync(dest, 0o755);
        }

        installed.push(dest);
      }

      console.log('');
      success(`Installed ${template} hook template`);
      console.log('');
      console.log(chalk.bold('Files created:'));
      for (const f of installed) {
        console.log('  ' + chalk.cyan(f));
      }

      if (template === 'jira-status') {
        console.log('');
        console.log(chalk.bold('Next steps:'));
        console.log(
          '  1. Edit ' +
            chalk.cyan(path.join(targetDir, 'jira-status.config.json')) +
            ' and replace REPLACE_ME with your Jira transition IDs.',
        );
        console.log('  2. Set the following environment variables:');
        console.log(
          '     ' + chalk.yellow('export JIRA_BASE_URL=https://your-company.atlassian.net'),
        );
        console.log('     ' + chalk.yellow('export JIRA_EMAIL=you@company.com'));
        console.log('     ' + chalk.yellow('export JIRA_TOKEN=your-api-token'));
        console.log('');
        console.log(
          '  3. Link Jira issues to tasks: ' +
            chalk.cyan('octomux task-ref-add <task-id> jira <JIRA-KEY>'),
        );
        console.log('');
        console.log(
          chalk.dim(
            'The hook fires when a task moves columns. ' +
              'Each move calls the Jira Transitions API with the configured transition ID.',
          ),
        );
      }

      console.log('');
    });
}
