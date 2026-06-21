import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../test-helpers.js';
import { classify, addRule, listRules, deleteRule } from './policy.js';

describe('policy engine', () => {
  beforeEach(() => {
    createTestDb();
  });

  // ─── Tier classification (table-driven) ─────────────────────────────────────

  describe('classify — default tiers', () => {
    it.each([
      // auto-allow tier (MCP reads via --allowedTools — classify still accepts them but they
      // never hit the gate; we model them as 'auto' for completeness)
      ['list_tasks', [], 'auto'],
      ['get_task', ['task-abc'], 'auto'],
      ['monitor_status', [], 'auto'],
      ['get_task_output', ['task-abc'], 'auto'],
      ['pull_linear_issue', ['LIN-123'], 'auto'],

      // read-only octomux subcommands are auto (never gated — context gathering)
      ['octomux', ['recent-repos'], 'auto'],
      ['octomux', ['default-branch', '--repo-path', '/tmp/repo'], 'auto'],
      ['octomux', ['list-tasks'], 'auto'],
      ['octomux', ['get-task', 'task-abc'], 'auto'],

      // ask tier (reversible writes via Bash)
      ['octomux', ['create-task', '--title', 'Foo'], 'ask'],
      ['octomux', ['add-agent', '--task', 'task-abc'], 'ask'],
      ['octomux', ['send-message', '--task', 'task-abc', '--text', 'hi'], 'ask'],
      ['octomux', ['set-status', '--task', 'task-abc', '--status', 'in_progress'], 'ask'],
      ['octomux', ['request-review', '--task', 'task-abc'], 'ask'],

      // always-ask tier (destructive — never silenced by a rule)
      ['octomux', ['delete-task', '--task', 'task-abc'], 'always-ask'],
      ['octomux', ['close-task', '--task', 'task-abc'], 'always-ask'],
    ] as const)('classify(%s, %j) → %s', (command, args, expected) => {
      expect(classify(command, [...args])).toBe(expected);
    });

    it('unknown octomux subcommand defaults to ask', () => {
      // unrecognised subcommand is treated as a reversible write (fail-safe)
      expect(classify('octomux', ['some-future-command'])).toBe('ask');
    });

    it('non-octomux bash command defaults to ask', () => {
      // Any arbitrary bash call is treated as ask if it reaches the gate
      expect(classify('bash', ['-c', 'echo hello'])).toBe('ask');
    });
  });

  // ─── Learnable allow-rules ───────────────────────────────────────────────────

  describe('allow-rules promote ask → auto', () => {
    it('an allow rule for create-task promotes it from ask to auto', () => {
      expect(classify('octomux', ['create-task'])).toBe('ask');

      addRule({ tool_name: 'octomux', match: { subcommand: 'create-task' }, effect: 'allow' });

      expect(classify('octomux', ['create-task'])).toBe('auto');
    });

    it('an allow rule for send-message promotes it from ask to auto', () => {
      addRule({ tool_name: 'octomux', match: { subcommand: 'send-message' }, effect: 'allow' });
      expect(classify('octomux', ['send-message', '--task', 't1'])).toBe('auto');
    });

    it('a rule without subcommand match applies to all subcommands in that tool', () => {
      addRule({ tool_name: 'octomux', match: null, effect: 'allow' });
      // ask-tier commands with a blanket rule → auto
      expect(classify('octomux', ['create-task'])).toBe('auto');
      expect(classify('octomux', ['add-agent'])).toBe('auto');
      // BUT always-ask commands are never affected by rules
      expect(classify('octomux', ['delete-task'])).toBe('always-ask');
      expect(classify('octomux', ['close-task'])).toBe('always-ask');
    });

    it('always-ask commands (delete/close) are NEVER silenced by a rule', () => {
      // Even a blanket allow rule must not downgrade always-ask to auto
      addRule({ tool_name: 'octomux', match: { subcommand: 'delete-task' }, effect: 'allow' });
      expect(classify('octomux', ['delete-task', '--task', 'task-abc'])).toBe('always-ask');

      addRule({ tool_name: 'octomux', match: { subcommand: 'close-task' }, effect: 'allow' });
      expect(classify('octomux', ['close-task', '--task', 'task-abc'])).toBe('always-ask');
    });

    it('a deny rule has no effect (deny is already the default; rules can only promote)', () => {
      addRule({ tool_name: 'octomux', match: { subcommand: 'create-task' }, effect: 'deny' });
      // deny rules are stored but ignored — the tier is unchanged
      expect(classify('octomux', ['create-task'])).toBe('ask');
    });
  });

  // ─── listRules / deleteRule ──────────────────────────────────────────────────

  describe('listRules', () => {
    it('returns an empty array when no rules exist', () => {
      expect(listRules()).toEqual([]);
    });

    it('returns all stored rules', () => {
      addRule({ tool_name: 'octomux', match: { subcommand: 'create-task' }, effect: 'allow' });
      addRule({ tool_name: 'octomux', match: null, effect: 'allow' });
      const rules = listRules();
      expect(rules).toHaveLength(2);
      expect(rules.every((r) => r.id)).toBe(true);
      expect(rules.every((r) => r.created_at)).toBe(true);
    });
  });

  describe('deleteRule', () => {
    it('removes the rule so it no longer affects classify', () => {
      addRule({ tool_name: 'octomux', match: { subcommand: 'create-task' }, effect: 'allow' });
      expect(classify('octomux', ['create-task'])).toBe('auto');

      const rules = listRules();
      expect(rules).toHaveLength(1);
      deleteRule(rules[0].id);

      expect(listRules()).toHaveLength(0);
      expect(classify('octomux', ['create-task'])).toBe('ask');
    });

    it('is a no-op for an unknown id', () => {
      // should not throw
      expect(() => deleteRule('nonexistent-rule-id')).not.toThrow();
    });
  });

  // ─── Rule persistence across calls ─────────────────────────────────────────

  describe('rule persistence', () => {
    it('multiple rules accumulate correctly', () => {
      addRule({ tool_name: 'octomux', match: { subcommand: 'create-task' }, effect: 'allow' });
      addRule({ tool_name: 'octomux', match: { subcommand: 'add-agent' }, effect: 'allow' });

      expect(classify('octomux', ['create-task'])).toBe('auto');
      expect(classify('octomux', ['add-agent'])).toBe('auto');
      // unaffected commands stay at their default tier
      expect(classify('octomux', ['send-message'])).toBe('ask');
      expect(classify('octomux', ['delete-task'])).toBe('always-ask');
    });
  });
});
