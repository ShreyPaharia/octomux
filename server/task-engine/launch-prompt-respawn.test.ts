import { describe, it, expect, afterEach } from '../bun-test.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildAgentStartupCommand } from './launch.js';
import { localSession } from '../compute/index.js';

// Regression test for the respawn EEXIST bug: the prompt file is written with
// the real fs module (not mocked) so an exclusive-create flag would actually
// throw here, unlike in launch.test.ts where fs.writeFileSync is a no-op mock.

let tmpDir: string;

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('buildAgentStartupCommand prompt file (real fs)', () => {
  it('overwrites an existing prompt file on respawn instead of throwing EEXIST', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-launch-'));
    const agentId = 'agent-respawn-1';

    await buildAgentStartupCommand(localSession, {
      baseCmd: 'claude --session-id abc',
      prompt: 'original prompt',
      worktreePath: tmpDir,
      agentId,
    });

    // Would reject (EEXIST) if the write weren't an overwrite — an uncaught
    // rejection here fails the test just as `expect(...).not.toThrow()` did
    // for the old synchronous call.
    await buildAgentStartupCommand(localSession, {
      baseCmd: 'claude --session-id abc',
      prompt: 'respawn prompt',
      worktreePath: tmpDir,
      agentId,
    });

    const promptFile = path.join(tmpDir, `.claude-prompt-${agentId}`);
    expect(fs.readFileSync(promptFile, 'utf8')).toContain('respawn prompt');
  });
});
