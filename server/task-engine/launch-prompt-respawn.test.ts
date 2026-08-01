import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildAgentStartupCommand } from './launch.js';

// Regression test for the respawn EEXIST bug: the prompt file is written with
// the real fs module (not mocked) so an exclusive-create flag would actually
// throw here, unlike in launch.test.ts where fs.writeFileSync is a no-op mock.

let tmpDir: string;

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('buildAgentStartupCommand prompt file (real fs)', () => {
  it('overwrites an existing prompt file on respawn instead of throwing EEXIST', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-launch-'));
    const agentId = 'agent-respawn-1';

    buildAgentStartupCommand({
      baseCmd: 'claude --session-id abc',
      prompt: 'original prompt',
      worktreePath: tmpDir,
      agentId,
    });

    expect(() =>
      buildAgentStartupCommand({
        baseCmd: 'claude --session-id abc',
        prompt: 'respawn prompt',
        worktreePath: tmpDir,
        agentId,
      }),
    ).not.toThrow();

    const promptFile = path.join(tmpDir, `.claude-prompt-${agentId}`);
    expect(fs.readFileSync(promptFile, 'utf8')).toBe('respawn prompt');
  });
});
