/**
 * Octomux's own agent role definitions (orchestrator / planner / reviewer), read
 * from the bundled plugin. Single source — see the note on `builtInSkillsDir()`
 * for why the repo and home tiers were removed.
 *
 * A user's personal subagents live in Claude Code's native `~/.claude/agents/`
 * and are not listed here; the harness resolves those itself.
 */
import fs from 'fs';
import path from 'path';
import { builtInAgentsDir } from './octomux-paths.js';

export interface AgentDefinition {
  name: string;
  description: string;
}

export interface AgentDetail {
  name: string;
  content: string;
}

function parseDescription(content: string): string {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return '';
  const descMatch = match[1].match(/^description:\s*(.+)$/m);
  return descMatch ? descMatch[1].trim() : '';
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

function validateName(name: string): void {
  if (name === '..' || name.includes('..') || !NAME_RE.test(name)) {
    throw new Error(`Invalid agent name: ${name}`);
  }
}

async function readAgentContent(name: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(path.join(builtInAgentsDir(), `${name}.md`), 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') return null;
    throw err;
  }
}

export async function listAgents(): Promise<AgentDefinition[]> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(builtInAgentsDir());
  } catch {
    return [];
  }

  const agents: AgentDefinition[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const name = entry.replace(/\.md$/, '');
    const content = await readAgentContent(name);
    if (content === null) continue;
    agents.push({ name, description: parseDescription(content) });
  }

  return agents.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getAgent(name: string): Promise<AgentDetail> {
  validateName(name);

  const content = await readAgentContent(name);
  if (content === null) {
    throw new Error(`Agent not found: ${name}`);
  }

  return { name, content };
}
