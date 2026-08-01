import { describe, it, expect } from 'vitest';
import { parsePrFromToolUse } from './hooks.js';

describe('parsePrFromToolUse', () => {
  // ── gh pr create ────────────────────────────────────────────────────────────

  it('parses gh pr create output with PR URL in stdout', () => {
    const command = 'gh pr create --title "fix: thing" --body ""';
    const toolResponse = 'Creating pull request...\nhttps://github.com/org/repo/pull/42\n';
    const result = parsePrFromToolUse(command, toolResponse);
    expect(result).toMatchObject({ url: 'https://github.com/org/repo/pull/42', number: 42 });
  });

  it('extracts --head branch from gh pr create', () => {
    const command = 'gh pr create --head my-feature --title "feat" --body ""';
    const toolResponse = 'https://github.com/org/repo/pull/7\n';
    const result = parsePrFromToolUse(command, toolResponse);
    expect(result).toMatchObject({ branch: 'my-feature', number: 7 });
  });

  it('extracts --head=branch (= form) from gh pr create', () => {
    const command = 'gh pr create --head=feature/stuff --title "x" --body ""';
    const toolResponse = 'https://github.com/org/repo/pull/99\n';
    const result = parsePrFromToolUse(command, toolResponse);
    expect(result).toMatchObject({ branch: 'feature/stuff', number: 99 });
  });

  it('returns null when gh pr create output has no URL (command still running)', () => {
    const command = 'gh pr create --title "x"';
    const toolResponse = 'Creating...';
    expect(parsePrFromToolUse(command, toolResponse)).toBeNull();
  });

  // ── git push ────────────────────────────────────────────────────────────────

  it('parses git push origin branch', () => {
    const result = parsePrFromToolUse('git push origin feat/my-feature', '');
    expect(result).toMatchObject({ branch: 'feat/my-feature' });
    expect(result?.url).toBeUndefined();
    expect(result?.number).toBeUndefined();
  });

  it('parses git push -u origin branch', () => {
    const result = parsePrFromToolUse('git push -u origin fix/thing', '');
    expect(result).toMatchObject({ branch: 'fix/thing' });
  });

  it('parses git push --set-upstream origin branch', () => {
    const result = parsePrFromToolUse('git push --set-upstream origin agents/abc123', '');
    expect(result).toMatchObject({ branch: 'agents/abc123' });
  });

  it('returns null when git push has no branch argument', () => {
    // e.g. bare `git push` with no remote/branch args
    expect(parsePrFromToolUse('git push', '')).toBeNull();
    expect(parsePrFromToolUse('git push origin', '')).toBeNull();
  });

  // ── unrecognised commands ────────────────────────────────────────────────────

  it('returns null for unrelated bash commands', () => {
    expect(parsePrFromToolUse('npm test', '')).toBeNull();
    expect(parsePrFromToolUse('bun run build', '')).toBeNull();
    expect(parsePrFromToolUse('cat README.md', '')).toBeNull();
  });

  it('returns null for empty command', () => {
    expect(parsePrFromToolUse('', '')).toBeNull();
  });
});
