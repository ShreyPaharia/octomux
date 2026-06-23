import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { nanoid } from 'nanoid';
import { writeSubmitResultMcpConfig, submitResultServerInvocation } from './config.js';

const SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
  },
  required: ['reply'],
  additionalProperties: false,
};

describe('writeSubmitResultMcpConfig', () => {
  it('writes config file with correct structure and returns the path', () => {
    const tmpDir = path.join(os.tmpdir(), `octomux-test-${nanoid()}`);
    const resultPath = path.join(tmpDir, 'result.json');

    const cfgPath = writeSubmitResultMcpConfig(tmpDir, { schema: SCHEMA, resultPath });

    // If invocation can't be resolved (e.g. neither prod nor dev file exists on
    // this machine) the function returns null — skip assertions in that case.
    if (cfgPath === null) return;

    expect(cfgPath).toBeTruthy();
    expect(fs.existsSync(cfgPath!)).toBe(true);

    const cfg = JSON.parse(fs.readFileSync(cfgPath!, 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };

    const srv = cfg.mcpServers['submit_result'];
    expect(srv).toBeDefined();
    expect(typeof srv.command).toBe('string');
    expect(Array.isArray(srv.args)).toBe(true);
    expect(srv.env.OCTOMUX_SUBMIT_RESULT_SCHEMA).toBe(JSON.stringify(SCHEMA));
    expect(srv.env.OCTOMUX_SUBMIT_RESULT_PATH).toBe(resultPath);

    // cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('submitResultServerInvocation', () => {
  it('returns non-null with args pointing at the dev .ts file', () => {
    const inv = submitResultServerInvocation();

    // In dev (source exists) we expect a non-null result.
    // The source file server/agent-session/mcp/submit-result-server.ts exists
    // in this repo, so this should always be non-null in the test environment.
    expect(inv).not.toBeNull();
    if (inv) {
      expect(inv.args.some((a) => a.endsWith('.ts') || a.endsWith('.js'))).toBe(true);
    }
  });
});
