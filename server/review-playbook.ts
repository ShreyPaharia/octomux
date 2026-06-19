import fs from 'fs';
import os from 'os';
import path from 'path';
import { repoShortName } from './review-tasks.js';
import { childLogger } from './logger.js';

const logger = childLogger('review-playbook');

const INDEX_FILE = 'INDEX.md';
/** Slugs must be filesystem-safe and stable: lowercase, dashed. */
function safeSlug(slug: string): string {
  return slug.replace(/[^a-zA-Z0-9-]+/g, '-').toLowerCase() || 'notes';
}

export function playbookDir(repoPath: string): string {
  return path.join(os.homedir(), '.octomux', 'review-playbook', repoShortName(repoPath));
}

export function readPlaybook(repoPath: string): {
  index: string | null;
  files: Array<{ slug: string; body: string }>;
} {
  const dir = playbookDir(repoPath);
  if (!fs.existsSync(dir)) return { index: null, files: [] };
  const indexPath = path.join(dir, INDEX_FILE);
  const index = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf-8') : null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== INDEX_FILE)
    .sort()
    .map((f) => ({ slug: f.replace(/\.md$/, ''), body: fs.readFileSync(path.join(dir, f), 'utf-8') }));
  return { index, files };
}

export function appendPlaybookNote(repoPath: string, slug: string, note: string): void {
  const dir = playbookDir(repoPath);
  fs.mkdirSync(dir, { recursive: true });
  const safe = safeSlug(slug);
  const topicPath = path.join(dir, `${safe}.md`);
  const existed = fs.existsSync(topicPath);
  if (!existed) fs.writeFileSync(topicPath, `# ${safe}\n\n`, 'utf-8');
  fs.appendFileSync(topicPath, `- ${note.trim()}\n`, 'utf-8');

  const indexPath = path.join(dir, INDEX_FILE);
  const indexBody = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf-8') : '# Review playbook\n\n';
  const link = `- [${safe}](${safe}.md)`;
  if (!indexBody.includes(`(${safe}.md)`)) {
    fs.writeFileSync(indexPath, `${indexBody.replace(/\n*$/, '\n')}${link}\n`, 'utf-8');
  } else if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, indexBody, 'utf-8');
  }
  logger.info({ repo_path: repoPath, slug: safe }, 'playbook note appended');
}
