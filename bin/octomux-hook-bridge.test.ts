import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_SRC = path.join(__dirname, 'octomux-hook-bridge.js');

// ─── Test HTTP server ─────────────────────────────────────────────────────────

interface CapturedRequest {
  method: string;
  url: string;
  body: string;
}

let server: http.Server;
let serverPort: number;
let capturedRequests: CapturedRequest[];

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    capturedRequests = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        capturedRequests.push({ method: req.method ?? 'GET', url: req.url ?? '/', body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      serverPort = typeof addr === 'object' && addr ? addr.port : 0;
      resolve();
    });
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

// ─── Temp directory helpers ───────────────────────────────────────────────────

let tmpDir: string;

function setupTmpDir(overrideBaseUrl?: string): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-bridge-test-'));
  // Copy the bridge script into the tmp dir
  const bridgeDest = path.join(tmpDir, 'octomux-hook-bridge.js');
  fs.copyFileSync(BRIDGE_SRC, bridgeDest);
  fs.chmodSync(bridgeDest, 0o500);

  const baseUrl = overrideBaseUrl ?? `http://127.0.0.1:${serverPort}`;
  fs.writeFileSync(
    path.join(tmpDir, 'config.json'),
    JSON.stringify({ baseUrl, token: 'test-token' }),
    { mode: 0o600 },
  );
}

function cleanupTmpDir(): void {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─── Runner helper ─────────────────────────────────────────────────────────────

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runBridge(stdinJson: string, bridgeDir?: string): Promise<RunResult> {
  const dir = bridgeDir ?? tmpDir;
  const bridgePath = path.join(dir, 'octomux-hook-bridge.js');

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bridgePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });

    child.stdin.write(stdinJson);
    child.stdin.end();
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

beforeAll(() => startServer());
afterAll(() => stopServer());

beforeEach(() => {
  capturedRequests = [];
  setupTmpDir();
});

afterEach(() => {
  cleanupTmpDir();
});

// ─── 1. sessionStart ──────────────────────────────────────────────────────────

it('sessionStart: POSTs to /api/hooks/session-start and returns {}', async () => {
  const event = {
    hook_event_name: 'sessionStart',
    conversation_id: 'conv-123',
    session_id: 'sess-456',
    is_background_agent: false,
  };
  const result = await runBridge(JSON.stringify(event));

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({});

  expect(capturedRequests).toHaveLength(1);
  const req = capturedRequests[0];
  expect(req.method).toBe('POST');
  expect(req.url).toBe('/api/hooks/session-start?token=test-token');
  const body = JSON.parse(req.body);
  expect(body).toEqual({
    conversation_id: 'conv-123',
    session_id: 'sess-456',
    is_background_agent: false,
  });
});

// ─── 2. beforeSubmitPrompt ────────────────────────────────────────────────────

it('beforeSubmitPrompt: POSTs to /api/hooks/user-prompt-submit and returns {"continue":true}', async () => {
  const event = {
    hook_event_name: 'beforeSubmitPrompt',
    conversation_id: 'conv-789',
    prompt: 'Hello, world!',
  };
  const result = await runBridge(JSON.stringify(event));

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ continue: true });

  expect(capturedRequests).toHaveLength(1);
  const req = capturedRequests[0];
  expect(req.method).toBe('POST');
  expect(req.url).toBe('/api/hooks/user-prompt-submit?token=test-token');
  const body = JSON.parse(req.body);
  expect(body).toEqual({ conversation_id: 'conv-789', prompt: 'Hello, world!' });
});

// ─── 3–6. beforeShellExecution ────────────────────────────────────────────────

describe('beforeShellExecution', () => {
  it.each([
    ['ls', 'allow', undefined],
    ['ls -la /tmp', 'allow', undefined],
  ])('command %j → permission %j', async (command, expectedPermission) => {
    const event = { hook_event_name: 'beforeShellExecution', command };
    const result = await runBridge(JSON.stringify(event));

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.permission).toBe(expectedPermission);
    // No HTTP calls for shell execution checks
    expect(capturedRequests).toHaveLength(0);
  });

  it.each([
    ['rm -rf /', 'rm -rf'],
    ['rm -rf /tmp/foo', 'rm -rf'],
    ['  rm  -rf /whatever', 'rm -rf'],
    ['git push --force', 'git push --force'],
    ['git push --force origin main', 'git push --force'],
    ['git reset --hard', 'git reset --hard'],
    ['git reset --hard HEAD', 'git reset --hard'],
  ])('denylist: %j → deny with label %j', async (command, expectedLabel) => {
    const event = { hook_event_name: 'beforeShellExecution', command };
    const result = await runBridge(JSON.stringify(event));

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.permission).toBe('deny');
    expect(out.user_message).toContain(expectedLabel);
    // No HTTP calls for denylist checks
    expect(capturedRequests).toHaveLength(0);
  });
});

// ─── 7. postToolUse ───────────────────────────────────────────────────────────

it('postToolUse: POSTs to /api/hooks/post-tool-use and returns {}', async () => {
  const event = {
    hook_event_name: 'postToolUse',
    conversation_id: 'conv-abc',
    tool_name: 'bash',
    tool_output: 'hello',
  };
  const result = await runBridge(JSON.stringify(event));

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({});

  expect(capturedRequests).toHaveLength(1);
  const req = capturedRequests[0];
  expect(req.method).toBe('POST');
  expect(req.url).toBe('/api/hooks/post-tool-use?token=test-token');
  const body = JSON.parse(req.body);
  expect(body.conversation_id).toBe('conv-abc');
  expect(body.hook_event_name).toBe('postToolUse');
});

// ─── 8. afterFileEdit ────────────────────────────────────────────────────────

it('afterFileEdit: POSTs to /api/hooks/post-tool-use and returns {}', async () => {
  const event = {
    hook_event_name: 'afterFileEdit',
    conversation_id: 'conv-def',
    file_path: '/tmp/foo.txt',
  };
  const result = await runBridge(JSON.stringify(event));

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({});

  expect(capturedRequests).toHaveLength(1);
  const req = capturedRequests[0];
  expect(req.method).toBe('POST');
  expect(req.url).toBe('/api/hooks/post-tool-use?token=test-token');
  const body = JSON.parse(req.body);
  expect(body.conversation_id).toBe('conv-def');
  expect(body.hook_event_name).toBe('afterFileEdit');
});

// ─── 9. Unknown event ─────────────────────────────────────────────────────────

it('unknown event name: returns {} with no HTTP call', async () => {
  const event = { hook_event_name: 'someUnknownEvent', conversation_id: 'conv-x' };
  const result = await runBridge(JSON.stringify(event));

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({});
  expect(capturedRequests).toHaveLength(0);
});

// ─── 10. Malformed stdin ──────────────────────────────────────────────────────

it('malformed stdin: returns {}, no HTTP, exit code 0', async () => {
  const result = await runBridge('not json at all');

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({});
  expect(capturedRequests).toHaveLength(0);
});

// ─── 11. Missing config.json ─────────────────────────────────────────────────

it('missing config.json: returns {}, no HTTP, exit code 0', async () => {
  // Remove the config.json that setupTmpDir wrote
  fs.rmSync(path.join(tmpDir, 'config.json'));

  const event = {
    hook_event_name: 'sessionStart',
    conversation_id: 'conv-1',
    session_id: 'sess-1',
  };
  const result = await runBridge(JSON.stringify(event));

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({});
  expect(capturedRequests).toHaveLength(0);
});

// ─── 12. HTTP server returns 500 ─────────────────────────────────────────────

it('HTTP 500 response: bridge still exits 0 with stdout {} (fail-open)', async () => {
  // Spin up a server that always returns 500
  const errorServer = http.createServer((_req, res) => {
    res.writeHead(500);
    res.end('Internal Server Error');
  });
  await new Promise<void>((resolve) => errorServer.listen(0, '127.0.0.1', resolve));
  const errorPort = (errorServer.address() as { port: number }).port;

  // Create a tmp dir with config pointing to the error server
  const errorTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-bridge-err-'));
  const bridgeDest = path.join(errorTmpDir, 'octomux-hook-bridge.js');
  fs.copyFileSync(BRIDGE_SRC, bridgeDest);
  fs.writeFileSync(
    path.join(errorTmpDir, 'config.json'),
    JSON.stringify({ baseUrl: `http://127.0.0.1:${errorPort}`, token: 'test-token' }),
  );

  try {
    const event = {
      hook_event_name: 'sessionStart',
      conversation_id: 'conv-500',
      session_id: 'sess-500',
      is_background_agent: false,
    };
    const result = await runBridge(JSON.stringify(event), errorTmpDir);

    // Fail-open: despite 500 response, bridge exits 0 and writes {}
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
  } finally {
    fs.rmSync(errorTmpDir, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) =>
      errorServer.close((err) => (err ? reject(err) : resolve())),
    );
  }
});
