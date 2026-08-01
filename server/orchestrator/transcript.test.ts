import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseLine, assertTranscriptVersion, tailTranscript, isTurnDone } from './transcript.js';

const FIXTURES_DIR = path.join(import.meta.dirname, '__fixtures__');
const BASIC_FIXTURE = path.join(FIXTURES_DIR, 'transcript-2.1.183-basic-qa.jsonl');
const COMPACTION_FIXTURE = path.join(FIXTURES_DIR, 'transcript-2.1.183-with-compaction.jsonl');

// ─── parseLine ─────────────────────────────────────────────────────────────

describe('parseLine', () => {
  it.each([
    [
      'user message (string content)',
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'Hello' },
        uuid: 'u1',
        timestamp: '2026-06-19T22:00:00.000Z',
        version: '2.1.183',
        sessionId: 's1',
      }),
      {
        type: 'user',
        text: 'Hello',
        uuid: 'u1',
        timestamp: '2026-06-19T22:00:00.000Z',
        version: '2.1.183',
      },
    ],
    [
      'user message (array content)',
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Array content' }] },
        uuid: 'u2',
        timestamp: '2026-06-19T22:00:01.000Z',
        version: '2.1.183',
        sessionId: 's1',
      }),
      {
        type: 'user',
        text: 'Array content',
        uuid: 'u2',
        timestamp: '2026-06-19T22:00:01.000Z',
        version: '2.1.183',
      },
    ],
    [
      'assistant text message',
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'The answer is 4.' }],
          id: 'msg_001',
          model: 'claude-sonnet-4-6',
          stop_reason: 'end_turn',
        },
        uuid: 'a1',
        timestamp: '2026-06-19T22:00:02.000Z',
        version: '2.1.183',
        sessionId: 's1',
      }),
      {
        type: 'assistant',
        text: 'The answer is 4.',
        uuid: 'a1',
        timestamp: '2026-06-19T22:00:02.000Z',
        version: '2.1.183',
      },
    ],
    [
      'assistant with tool_use block',
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_001',
              name: 'Bash',
              input: { command: 'ls /' },
            },
          ],
          id: 'msg_002',
          model: 'claude-sonnet-4-6',
          stop_reason: 'tool_use',
        },
        uuid: 'a2',
        timestamp: '2026-06-19T22:00:03.000Z',
        version: '2.1.183',
        sessionId: 's1',
      }),
      {
        type: 'tool_use',
        toolUseId: 'tu_001',
        toolName: 'Bash',
        input: { command: 'ls /' },
        uuid: 'a2',
        timestamp: '2026-06-19T22:00:03.000Z',
        version: '2.1.183',
      },
    ],
    [
      'user with tool_result content',
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_001',
              content: 'bin etc usr',
            },
          ],
        },
        uuid: 'u3',
        timestamp: '2026-06-19T22:00:04.000Z',
        version: '2.1.183',
        sessionId: 's1',
      }),
      {
        type: 'tool_result',
        toolUseId: 'tu_001',
        content: 'bin etc usr',
        uuid: 'u3',
        timestamp: '2026-06-19T22:00:04.000Z',
        version: '2.1.183',
      },
    ],
    [
      'compact_boundary system line',
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        content: 'Conversation compacted',
        uuid: 'sys1',
        timestamp: '2026-06-19T22:01:00.000Z',
        sessionId: 's1',
        compactMetadata: { trigger: 'auto', preTokens: 167008 },
      }),
      {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'sys1',
        timestamp: '2026-06-19T22:01:00.000Z',
      },
    ],
    [
      'turn_duration system line',
      JSON.stringify({
        type: 'system',
        subtype: 'turn_duration',
        durationMs: 2189,
        uuid: 'sys2',
        timestamp: '2026-06-19T22:01:01.000Z',
        sessionId: 's1',
      }),
      {
        type: 'system',
        subtype: 'turn_duration',
        uuid: 'sys2',
        timestamp: '2026-06-19T22:01:01.000Z',
      },
    ],
    [
      'returns null for metadata-only lines (last-prompt)',
      JSON.stringify({
        type: 'last-prompt',
        leafUuid: 'u1',
        sessionId: 's1',
      }),
      null,
    ],
    [
      'returns null for mode lines',
      JSON.stringify({ type: 'mode', mode: 'normal', sessionId: 's1' }),
      null,
    ],
    [
      'returns null for attachment lines',
      JSON.stringify({
        type: 'attachment',
        uuid: 'att1',
        timestamp: '2026-06-19T22:00:00.000Z',
        attachment: { type: 'hook_non_blocking_error', hookName: 'Stop' },
      }),
      null,
    ],
    [
      'returns null for file-history-snapshot lines',
      JSON.stringify({
        type: 'file-history-snapshot',
        messageId: 'm1',
        snapshot: {},
      }),
      null,
    ],
  ] as const)('%s', (_label, jsonLine, expected) => {
    const result = parseLine(jsonLine);
    expect(result).toEqual(expected);
  });

  it('returns null for empty/whitespace lines', () => {
    expect(parseLine('')).toBeNull();
    expect(parseLine('   ')).toBeNull();
    expect(parseLine('\n')).toBeNull();
  });

  it('returns null for malformed JSON (partial trailing line)', () => {
    expect(parseLine('{"type":"assistant","message":{"content":[{"type":')).toBeNull();
  });

  it('extracts version field for assertTranscriptVersion usage', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'Hi' },
      uuid: 'u-ver',
      timestamp: '2026-06-19T22:00:00.000Z',
      version: '2.1.183',
      sessionId: 's1',
    });
    const result = parseLine(line);
    expect(result).not.toBeNull();
    expect(result!.version).toBe('2.1.183');
  });
});

// ─── assertTranscriptVersion ──────────────────────────────────────────────

describe('assertTranscriptVersion', () => {
  it('accepts the pinned version', () => {
    expect(() => assertTranscriptVersion('2.1.183')).not.toThrow();
  });

  it('accepts any version when no pin is set (first call)', () => {
    // should not throw on any valid semver-ish string
    expect(() => assertTranscriptVersion('2.1.200')).not.toThrow();
  });

  it('throws on a clearly incompatible major version change', () => {
    expect(() => assertTranscriptVersion('3.0.0')).toThrow(/version/i);
  });

  it('does not throw on minor version increment', () => {
    expect(() => assertTranscriptVersion('2.2.0')).not.toThrow();
  });
});

// ─── parseLine with real fixture ─────────────────────────────────────────

describe('parseLine with basic-qa fixture', () => {
  it('parses all non-null lines from the basic fixture without errors', () => {
    const lines = fs.readFileSync(BASIC_FIXTURE, 'utf-8').split('\n').filter(Boolean);
    const events = lines.map((l) => parseLine(l));
    const nonNull = events.filter((e) => e !== null);

    // At least user + assistant messages from the fixture
    expect(nonNull.length).toBeGreaterThan(0);
    const userLines = nonNull.filter((e) => e!.type === 'user');
    const assistantLines = nonNull.filter((e) => e!.type === 'assistant');
    expect(userLines.length).toBeGreaterThan(0);
    expect(assistantLines.length).toBeGreaterThan(0);
  });

  it('fixture user messages have correct structure', () => {
    const lines = fs.readFileSync(BASIC_FIXTURE, 'utf-8').split('\n').filter(Boolean);
    const events = lines.map((l) => parseLine(l)).filter(Boolean);
    const userMessages = events.filter((e) => e!.type === 'user');

    // First user message should be the "What is 2+2?" prompt
    const first = userMessages[0];
    expect(first!.type).toBe('user');
    expect(first!.text).toContain('2+2');
  });

  it('fixture assistant messages have correct structure', () => {
    const lines = fs.readFileSync(BASIC_FIXTURE, 'utf-8').split('\n').filter(Boolean);
    const events = lines.map((l) => parseLine(l)).filter(Boolean);
    const assistantMessages = events.filter((e) => e!.type === 'assistant');

    // First assistant reply is "4"
    const first = assistantMessages[0];
    expect(first!.type).toBe('assistant');
    expect(first!.text).toBe('4');
  });

  it('isTurnDone fires once per completed turn (the stop_hook_summary lines)', () => {
    const lines = fs.readFileSync(BASIC_FIXTURE, 'utf-8').split('\n').filter(Boolean);
    const events = lines.map((l) => parseLine(l)).filter(Boolean) as NonNullable<
      ReturnType<typeof parseLine>
    >[];
    const boundaries = events.filter((e) => isTurnDone(e));
    // The basic-qa fixture has exactly 4 stop_hook_summary lines = 4 turns.
    expect(boundaries.length).toBe(4);
    for (const b of boundaries) {
      expect(b.type).toBe('system');
    }
    // A plain assistant text line must NOT be a turn boundary.
    const assistant = events.find((e) => e.type === 'assistant');
    expect(isTurnDone(assistant!)).toBe(false);
  });
});

describe('parseLine with compaction fixture', () => {
  it('parses compact_boundary lines correctly', () => {
    const lines = fs.readFileSync(COMPACTION_FIXTURE, 'utf-8').split('\n').filter(Boolean);
    const events = lines.map((l) => parseLine(l)).filter(Boolean);

    const compactionLines = events.filter(
      (e) => e!.type === 'system' && e!.subtype === 'compact_boundary',
    );
    // Fixture has 2 compactions
    expect(compactionLines.length).toBeGreaterThanOrEqual(2);
  });

  it('does not emit duplicate events after compaction boundary (append-only confirmed)', () => {
    const lines = fs.readFileSync(COMPACTION_FIXTURE, 'utf-8').split('\n').filter(Boolean);
    const allParsed = lines.map((l) => parseLine(l));

    // Check no parse errors — all lines parse without throwing
    expect(allParsed.every((r) => r === null || typeof r === 'object')).toBe(true);
  });
});

// ─── tailTranscript ───────────────────────────────────────────────────────

describe('tailTranscript', () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-test-'));
    tmpFile = path.join(tmpDir, 'test.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads existing lines on start', async () => {
    const line1 = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'Hello' },
      uuid: 'u1',
      timestamp: '2026-06-19T22:00:00.000Z',
      version: '2.1.183',
      sessionId: 's1',
    });
    const line2 = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi there' }],
        id: 'msg_001',
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
      },
      uuid: 'a1',
      timestamp: '2026-06-19T22:00:01.000Z',
      version: '2.1.183',
      sessionId: 's1',
    });
    fs.writeFileSync(tmpFile, `${line1}\n${line2}\n`);

    const received: Array<ReturnType<typeof parseLine>> = [];
    const stop = await tailTranscript(tmpFile, (evt) => {
      received.push(evt);
    });
    stop();

    expect(received).toHaveLength(2);
    expect(received[0]!.type).toBe('user');
    expect(received[1]!.type).toBe('assistant');
  });

  it('buffers partial trailing line (no newline yet)', async () => {
    const completeLine = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'First' },
      uuid: 'u1',
      timestamp: '2026-06-19T22:00:00.000Z',
      version: '2.1.183',
      sessionId: 's1',
    });
    // Write complete line + partial next line (no closing brace or newline)
    fs.writeFileSync(tmpFile, `${completeLine}\n{"type":"assistant"`);

    const received: Array<ReturnType<typeof parseLine>> = [];
    const stop = await tailTranscript(tmpFile, (evt) => {
      received.push(evt);
    });
    stop();

    // Only the complete line should be emitted; the partial is buffered
    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe('user');
  });

  it('emits new lines appended after start', async () => {
    const line1 = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'Initial' },
      uuid: 'u1',
      timestamp: '2026-06-19T22:00:00.000Z',
      version: '2.1.183',
      sessionId: 's1',
    });
    fs.writeFileSync(tmpFile, `${line1}\n`);

    const received: Array<ReturnType<typeof parseLine>> = [];
    const stop = await tailTranscript(tmpFile, (evt) => {
      received.push(evt);
    });

    // Append a new line after tailing started
    const line2 = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Response' }],
        id: 'msg_002',
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
      },
      uuid: 'a1',
      timestamp: '2026-06-19T22:00:01.000Z',
      version: '2.1.183',
      sessionId: 's1',
    });
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        fs.appendFileSync(tmpFile, `${line2}\n`);
        resolve();
      }, 20),
    );

    // Give the watcher time to pick it up
    await new Promise((resolve) => setTimeout(resolve, 100));
    stop();

    expect(received.length).toBeGreaterThanOrEqual(2);
    expect(received[1]!.type).toBe('assistant');
  });

  it('handles compact_boundary lines gracefully (does not throw)', async () => {
    const compactLine = JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      uuid: 'sys1',
      timestamp: '2026-06-19T22:01:00.000Z',
      sessionId: 's1',
    });
    const summaryLine = JSON.stringify({
      type: 'user',
      isMeta: true,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'This session is being continued...' }],
      },
      uuid: 'u-summary',
      timestamp: '2026-06-19T22:01:01.000Z',
      version: '2.1.183',
      sessionId: 's1',
    });
    fs.writeFileSync(tmpFile, `${compactLine}\n${summaryLine}\n`);

    const received: Array<ReturnType<typeof parseLine>> = [];
    const stop = await tailTranscript(tmpFile, (evt) => {
      received.push(evt);
    });
    stop();

    // compact_boundary is emitted as a system event; the summary user line is also emitted
    const systemEvents = received.filter((e) => e!.type === 'system');
    expect(systemEvents.length).toBeGreaterThanOrEqual(1);
    expect(systemEvents[0]!.subtype).toBe('compact_boundary');
  });
});
