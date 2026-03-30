import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  return path.resolve(__dirname, '..', 'agents');
}

function customDir(): string {
  return process.env.OCTOMUX_AGENTS_DIR || path.join(os.homedir(), '.octomux', 'agents');
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

export async function listAgents(): Promise<AgentDefinition[]> {
  const builtIn = builtInDir();
  const custom = customDir();
  const agents = new Map<string, AgentDefinition>();

  if (await exists(builtIn)) {
    const entries = await fs.promises.readdir(builtIn);
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const name = entry.replace('.md', '');
      const content = await fs.promises.readFile(path.join(builtIn, entry), 'utf-8');
      const fm = parseFrontmatter(content);
      agents.set(name, { name, description: fm.description, isCustom: false });
    }
  }

  if (await exists(custom)) {
    const entries = await fs.promises.readdir(custom);
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const name = entry.replace('.md', '');
      const content = await fs.promises.readFile(path.join(custom, entry), 'utf-8');
      const fm = parseFrontmatter(content);
      const existing = agents.get(name);
      agents.set(name, {
        name,
        description: fm.description || existing?.description || '',
        isCustom: true,
      });
    }
  }

  return Array.from(agents.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getAgent(name: string): Promise<AgentDetail> {
  const builtInPath = path.join(builtInDir(), `${name}.md`);
  const customPath = path.join(customDir(), `${name}.md`);

  const hasBuiltIn = await exists(builtInPath);
  const hasCustom = await exists(customPath);

  if (!hasBuiltIn && !hasCustom) {
    throw new Error(`Agent not found: ${name}`);
  }

  const defaultContent = hasBuiltIn ? await fs.promises.readFile(builtInPath, 'utf-8') : '';
  const customContent = hasCustom ? await fs.promises.readFile(customPath, 'utf-8') : null;

  return {
    name,
    content: customContent ?? defaultContent,
    defaultContent,
    isCustom: hasCustom,
  };
}

export async function saveAgent(name: string, content: string): Promise<void> {
  const dir = customDir();
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, `${name}.md`), content, 'utf-8');
}

export async function resetAgent(name: string): Promise<void> {
  const customPath = path.join(customDir(), `${name}.md`);
  try {
    await fs.promises.unlink(customPath);
  } catch (err: any) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
}

export async function createAgent(name: string, content: string): Promise<void> {
  const customPath = path.join(customDir(), `${name}.md`);
  if (await exists(customPath)) {
    throw new Error(`Agent already exists: ${name}`);
  }
  await saveAgent(name, content);
}

export async function deleteAgent(name: string): Promise<void> {
  const builtInPath = path.join(builtInDir(), `${name}.md`);
  if (await exists(builtInPath)) {
    throw new Error(`Cannot delete built-in agent: ${name}. Use reset to restore defaults.`);
  }
  const customPath = path.join(customDir(), `${name}.md`);
  if (!(await exists(customPath))) {
    throw new Error(`Agent not found: ${name}`);
  }
  await fs.promises.unlink(customPath);
}
