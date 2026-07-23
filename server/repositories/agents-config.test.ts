import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../test-helpers.js';
import { getDb } from '../db.js';
import {
  createAgent,
  getAgent,
  listAgents,
  updateAgent,
  deleteAgent,
  getAgentByChannel,
} from './agents-config.js';

describe('agents-config repo', () => {
  beforeEach(() => {
    createTestDb();
  });

  it('createAgent inserts a row and returns a nanoid(12) id', () => {
    const id = createAgent({ name: 'Ops Agent', system_prompt: 'You watch prod.' });

    expect(id).toHaveLength(12);
    const row = getAgent(id);
    expect(row).toBeDefined();
    expect(row!.name).toBe('Ops Agent');
    expect(row!.system_prompt).toBe('You watch prod.');
    expect(row!.channel).toBeNull();
    expect(row!.channel_config).toBeNull();
    expect(row!.created_at).toBeTruthy();
    expect(row!.updated_at).toBeTruthy();
  });

  it('createAgent stores an optional channel + channel_config', () => {
    const id = createAgent({
      name: 'Telegram Agent',
      system_prompt: 'Chat prompt.',
      channel: 'telegram',
      channel_config: JSON.stringify({ threadKey: 'chat-1' }),
    });

    const row = getAgent(id);
    expect(row!.channel).toBe('telegram');
    expect(JSON.parse(row!.channel_config!)).toEqual({ threadKey: 'chat-1' });
  });

  it('getAgent returns undefined for an unknown id', () => {
    expect(getAgent('does-not-exist')).toBeUndefined();
  });

  it('listAgents returns all agent configs', () => {
    createAgent({ name: 'A', system_prompt: 'p1' });
    createAgent({ name: 'B', system_prompt: 'p2' });

    const rows = listAgents();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.name).sort()).toEqual(['A', 'B']);
  });

  it('updateAgent patches given fields and leaves others untouched', () => {
    const id = createAgent({ name: 'Original', system_prompt: 'orig prompt' });
    const before = getAgent(id)!;

    updateAgent(id, { name: 'Renamed' });

    const after = getAgent(id)!;
    expect(after.name).toBe('Renamed');
    expect(after.system_prompt).toBe('orig prompt');
    expect(after.created_at).toBe(before.created_at);
  });

  it('updateAgent bumps updated_at', () => {
    const id = createAgent({ name: 'Original', system_prompt: 'orig prompt' });

    // Force a distinguishable updated_at by backdating the row first.
    getDb()
      .prepare(`UPDATE agent_configs SET updated_at = '2000-01-01 00:00:00' WHERE id = ?`)
      .run(id);
    expect(getAgent(id)!.updated_at).toBe('2000-01-01 00:00:00');

    updateAgent(id, { system_prompt: 'new prompt' });

    const after = getAgent(id)!;
    expect(after.updated_at).not.toBe('2000-01-01 00:00:00');
    expect(after.system_prompt).toBe('new prompt');
  });

  it('updateAgent is a no-op for an unknown id', () => {
    expect(() => updateAgent('nope', { name: 'X' })).not.toThrow();
  });

  it('deleteAgent removes the row', () => {
    const id = createAgent({ name: 'Doomed', system_prompt: 'p' });
    deleteAgent(id);
    expect(getAgent(id)).toBeUndefined();
  });

  it('deleteAgent is a no-op for an unknown id', () => {
    expect(() => deleteAgent('nope')).not.toThrow();
  });

  it('getAgentByChannel matches a channel-wide binding (no threadKey)', () => {
    const id = createAgent({
      name: 'Channel-wide',
      system_prompt: 'p',
      channel: 'telegram',
      channel_config: JSON.stringify({}),
    });

    expect(getAgentByChannel('telegram', 'any-thread')?.id).toBe(id);
    expect(getAgentByChannel('slack', 'any-thread')).toBeUndefined();
  });

  it('getAgentByChannel matches a specific threadKey binding only for that thread', () => {
    const id = createAgent({
      name: 'Thread-bound',
      system_prompt: 'p',
      channel: 'telegram',
      channel_config: JSON.stringify({ threadKey: 'chat-42' }),
    });

    expect(getAgentByChannel('telegram', 'chat-42')?.id).toBe(id);
    expect(getAgentByChannel('telegram', 'chat-99')).toBeUndefined();
  });

  it('getAgentByChannel prefers a specific threadKey match over a channel-wide binding', () => {
    createAgent({
      name: 'Channel-wide',
      system_prompt: 'p',
      channel: 'telegram',
      channel_config: JSON.stringify({}),
    });
    const specific = createAgent({
      name: 'Thread-bound',
      system_prompt: 'p',
      channel: 'telegram',
      channel_config: JSON.stringify({ threadKey: 'chat-42' }),
    });

    expect(getAgentByChannel('telegram', 'chat-42')?.id).toBe(specific);
  });

  it('getAgentByChannel returns undefined with no channel_config at all', () => {
    createAgent({ name: 'No channel', system_prompt: 'p' });
    expect(getAgentByChannel('telegram', 'chat-1')).toBeUndefined();
  });
});
