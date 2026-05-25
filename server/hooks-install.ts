import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { childLogger } from './logger.js';

const logger = childLogger('hooks-install');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface TemplateManifest {
  event: string;
  files: string[];
}

export function resolveTemplatesHooksDir(): string {
  const candidates = [
    path.resolve(__dirname, '..', 'templates', 'hooks'),
    path.resolve(__dirname, '..', '..', 'templates', 'hooks'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

export function listHookTemplates(): string[] {
  const base = resolveTemplatesHooksDir();
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base).filter((f) => {
    try {
      return fs.statSync(path.join(base, f)).isDirectory();
    } catch {
      return false;
    }
  });
}

export function isHookTemplateInstalled(
  template: string,
  hooksBase = path.join(os.homedir(), '.octomux', 'hooks'),
): boolean {
  const manifest = readTemplateManifest(template);
  if (!manifest) return false;
  const targetDir = path.join(hooksBase, `${manifest.event}.d`);
  return manifest.files.every((f) => fs.existsSync(path.join(targetDir, f)));
}

function readTemplateManifest(template: string): TemplateManifest | null {
  const manifestPath = path.join(resolveTemplatesHooksDir(), template, 'template.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as TemplateManifest;
  } catch (err) {
    logger.warn({ template, err }, 'failed to parse template.json');
    return null;
  }
}

/** Install a hook template into ~/.octomux/hooks (or hooksBase). Returns installed file paths. */
export function installHookTemplate(
  template: string,
  hooksBase = path.join(os.homedir(), '.octomux', 'hooks'),
): string[] {
  const templatesBase = resolveTemplatesHooksDir();
  const templateDir = path.join(templatesBase, template);

  if (!fs.existsSync(templateDir)) {
    throw new Error(
      `Template "${template}" not found. Available: ${listHookTemplates().join(', ') || '(none)'}`,
    );
  }

  const manifest = readTemplateManifest(template);
  if (!manifest) {
    throw new Error(`template.json not found or invalid for "${template}"`);
  }

  const targetDir = path.join(hooksBase, `${manifest.event}.d`);
  fs.mkdirSync(targetDir, { recursive: true });

  const installed: string[] = [];
  for (const fileName of manifest.files) {
    const src = path.join(templateDir, fileName);
    const dest = path.join(targetDir, fileName);
    if (!fs.existsSync(src)) {
      throw new Error(`Template file not found: ${src}`);
    }
    fs.copyFileSync(src, dest);
    if (!fileName.endsWith('.json')) {
      fs.chmodSync(dest, 0o755);
    }
    installed.push(dest);
  }

  logger.info({ template, hooks_base: hooksBase, files: installed }, 'installed hook template');
  return installed;
}
