import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { listAgents, getAgent, saveAgent, resetAgent, deleteAgent } from './agents.js';

describe('agents', () => {
  const tmpDir = path.join(os.tmpdir(), `octomux-agents-test-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    vi.stubEnv('OCTOMUX_AGENTS_DIR', tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  describe('listAgents', () => {
    it('returns built-in agents', async () => {
      const agents = await listAgents();
      const names = agents.map((a) => a.name);
      expect(names).toContain('orchestrator');
      expect(names).toContain('reviewer');
    });

    it('marks custom overrides as isCustom', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'orchestrator.md'),
        '---\nname: orchestrator\ndescription: Custom orchestrator\n---\nCustom content',
      );

      const agents = await listAgents();
      const orchestrator = agents.find((a) => a.name === 'orchestrator');
      expect(orchestrator?.isCustom).toBe(true);
    });

    it('includes user-created agents', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'my-agent.md'),
        '---\nname: my-agent\ndescription: A custom agent\n---\nContent',
      );

      const agents = await listAgents();
      const names = agents.map((a) => a.name);
      expect(names).toContain('my-agent');
    });
  });

  describe('getAgent', () => {
    it('returns built-in agent with default content', async () => {
      const agent = await getAgent('orchestrator');
      expect(agent.name).toBe('orchestrator');
      expect(agent.content).toContain('Octomux Orchestrator');
      expect(agent.defaultContent).toBe(agent.content);
      expect(agent.isCustom).toBe(false);
    });

    it('returns custom content when override exists', async () => {
      fs.writeFileSync(path.join(tmpDir, 'orchestrator.md'), 'Custom prompt');

      const agent = await getAgent('orchestrator');
      expect(agent.content).toBe('Custom prompt');
      expect(agent.defaultContent).toContain('Octomux Orchestrator');
      expect(agent.isCustom).toBe(true);
    });

    it('throws for non-existent agent', async () => {
      await expect(getAgent('nonexistent')).rejects.toThrow();
    });
  });

  describe('saveAgent', () => {
    it('writes custom override file', async () => {
      await saveAgent('orchestrator', 'My custom prompt');

      const content = fs.readFileSync(path.join(tmpDir, 'orchestrator.md'), 'utf-8');
      expect(content).toBe('My custom prompt');
    });
  });

  describe('resetAgent', () => {
    it('deletes custom override for built-in agent', async () => {
      fs.writeFileSync(path.join(tmpDir, 'orchestrator.md'), 'Custom');
      await resetAgent('orchestrator');

      expect(fs.existsSync(path.join(tmpDir, 'orchestrator.md'))).toBe(false);
    });

    it('no-ops when no custom override exists', async () => {
      await resetAgent('orchestrator');
    });
  });

  describe('deleteAgent', () => {
    it('deletes user-created agent', async () => {
      fs.writeFileSync(path.join(tmpDir, 'my-agent.md'), 'Content');
      await deleteAgent('my-agent');

      expect(fs.existsSync(path.join(tmpDir, 'my-agent.md'))).toBe(false);
    });

    it('throws when trying to delete built-in agent', async () => {
      await expect(deleteAgent('orchestrator')).rejects.toThrow();
    });
  });
});
