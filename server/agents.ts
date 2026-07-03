import fs from 'fs';
import path from 'path';
import { builtInAgentsDir, homeAgentsDir, repoAgentsDir } from './octomux-paths.js';

export interface AgentDefinition {
  name: string;
  description: string;
  isCustom: boolean;
}

export interface AgentDetail {
  name: string;
  content: string;
  defaultContent: string;
  isCustom: boolean;
}

function builtInDir(): string {
  return builtInAgentsDir();
}

function customDir(): string {
  return homeAgentsDir();
}

function parseFrontmatter(content: string): { name: string; description: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { name: '', description: '' };
  const fm = match[1];
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const descMatch = fm.match(/^description:\s*(.+)$/m);
  return {
    name: nameMatch ? nameMatch[1].trim() : '',
    description: descMatch ? descMatch[1].trim() : '',
  };
}

export function isBuiltInAgent(name: string): boolean {
  return fs.existsSync(path.join(builtInDir(), `${name}.md`));
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

async function loadAgentsFromDir(
  dir: string,
  isCustom: boolean,
  into: Map<string, AgentDefinition>,
): Promise<void> {
  if (!(await exists(dir))) return;
  const entries = await fs.promises.readdir(dir);
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const name = entry.replace('.md', '');
    const content = await fs.promises.readFile(path.join(dir, entry), 'utf-8');
    const fm = parseFrontmatter(content);
    const existing = into.get(name);
    into.set(name, {
      name,
      description: fm.description || existing?.description || '',
      isCustom: isCustom || existing?.isCustom || false,
    });
  }
}

/** Loader precedence: repo → home → built-in (later sources override earlier). */
export async function listAgents(repoPath?: string): Promise<AgentDefinition[]> {
  const agents = new Map<string, AgentDefinition>();

  await loadAgentsFromDir(builtInDir(), false, agents);
  await loadAgentsFromDir(customDir(), true, agents);
  if (repoPath) {
    await loadAgentsFromDir(repoAgentsDir(repoPath), true, agents);
  }

  return Array.from(agents.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getAgent(name: string, repoPath?: string): Promise<AgentDetail> {
  const builtInPath = path.join(builtInDir(), `${name}.md`);
  const homePath = path.join(customDir(), `${name}.md`);
  const repoPath_ = repoPath ? path.join(repoAgentsDir(repoPath), `${name}.md`) : null;

  const hasBuiltIn = await exists(builtInPath);
  const hasHome = await exists(homePath);
  const hasRepo = repoPath_ ? await exists(repoPath_) : false;

  if (!hasBuiltIn && !hasHome && !hasRepo) {
    throw new Error(`Agent not found: ${name}`);
  }

  const defaultContent = hasBuiltIn ? await fs.promises.readFile(builtInPath, 'utf-8') : '';
  const homeContent = hasHome ? await fs.promises.readFile(homePath, 'utf-8') : null;
  const repoContent = hasRepo && repoPath_ ? await fs.promises.readFile(repoPath_, 'utf-8') : null;

  return {
    name,
    content: repoContent ?? homeContent ?? defaultContent,
    defaultContent,
    isCustom: hasRepo || hasHome,
  };
}

function writeAgentsDir(repoPath?: string): string {
  return repoPath ? repoAgentsDir(repoPath) : customDir();
}

export async function saveAgent(name: string, content: string, repoPath?: string): Promise<void> {
  const dir = writeAgentsDir(repoPath);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, `${name}.md`), content, 'utf-8');
}

export async function resetAgent(name: string, repoPath?: string): Promise<void> {
  const customPath = path.join(writeAgentsDir(repoPath), `${name}.md`);
  try {
    await fs.promises.unlink(customPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}

export async function createAgent(name: string, content: string, repoPath?: string): Promise<void> {
  const customPath = path.join(writeAgentsDir(repoPath), `${name}.md`);
  if (await exists(customPath)) {
    throw new Error(`Agent already exists: ${name}`);
  }
  await saveAgent(name, content, repoPath);
}

/**
 * Sync effective agent files (repo → home → built-in) to
 * `.claude/agents/` in `cwd` (defaults to process.cwd) so `claude --agent <name>`
 * resolves them when launched in that directory.
 */
export async function syncAgents(cwd?: string): Promise<void> {
  const { claudeCodeHarness } = await import('./harnesses/claude-code.js');
  await claudeCodeHarness.syncAgents(cwd ?? process.cwd());
}

export async function deleteAgent(name: string, repoPath?: string): Promise<void> {
  if (!repoPath && (await exists(path.join(builtInDir(), `${name}.md`)))) {
    throw new Error(`Cannot delete built-in agent: ${name}. Use reset to restore defaults.`);
  }
  const customPath = path.join(writeAgentsDir(repoPath), `${name}.md`);
  if (!(await exists(customPath))) {
    throw new Error(`Agent not found: ${name}`);
  }
  await fs.promises.unlink(customPath);
}
