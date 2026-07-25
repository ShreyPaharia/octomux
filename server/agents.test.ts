import { describe, it, expect } from 'vitest';

import { listAgents, getAgent } from './agents.js';

describe('agents', () => {
  describe('listAgents', () => {
    it('returns the built-in roles with descriptions parsed from frontmatter', async () => {
      const agents = await listAgents();
      const names = agents.map((a) => a.name);

      expect(names).toEqual(expect.arrayContaining(['orchestrator', 'planner', 'reviewer']));
      const orchestrator = agents.find((a) => a.name === 'orchestrator');
      expect(orchestrator?.description.length).toBeGreaterThan(0);
    });
  });

  describe('getAgent', () => {
    it('returns content for a built-in role', async () => {
      const agent = await getAgent('orchestrator');
      expect(agent.name).toBe('orchestrator');
      expect(agent.content).toContain('Octomux Orchestrator');
    });

    it('throws for a non-existent agent', async () => {
      await expect(getAgent('nonexistent')).rejects.toThrow('Agent not found: nonexistent');
    });

    it('rejects an invalid/traversal name', async () => {
      await expect(getAgent('..')).rejects.toThrow('Invalid agent name');
      await expect(getAgent('../etc')).rejects.toThrow('Invalid agent name');
    });
  });
});
