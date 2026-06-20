/**
 * server/orchestrator/transcript.ts
 *
 * Thin transcript-JSONL normalizer for the orchestrator chat (Task 1.3).
 *
 * Key facts from Phase-0 spike (claude 2.1.183):
 *  - The transcript is APPEND-ONLY — compaction appends a compact_boundary system
 *    line + a summary user line; it does NOT rewrite the file.
 *  - Lines follow newline-delimited JSON (NDJSON / JSONL).
 *  - Partial trailing lines (in-progress writes) must be buffered, not emitted.
 *  - The "version" field is present on user/assistant lines; we use it for a
 *    major-version assertion.
 *
 * Public surface:
 *   parseLine(rawLine)  →  ChatEvent | null
 *   assertTranscriptVersion(version)  →  void (throws on incompatible major bump)
 *   tailTranscript(path, onEvent)  →  Promise<StopFn>
 */

import fs from 'fs';
import { childLogger } from '../logger.js';

const logger = childLogger('orchestrator/transcript');

// ─── Types ────────────────────────────────────────────────────────────────────

/** Normalised chat event types emitted by parseLine. */
export type ChatEventType = 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system';

export interface BaseChatEvent {
  type: ChatEventType;
  uuid: string;
  timestamp: string;
  version?: string;
}

export interface UserEvent extends BaseChatEvent {
  type: 'user';
  text: string;
}

export interface AssistantEvent extends BaseChatEvent {
  type: 'assistant';
  text: string;
}

export interface ToolUseEvent extends BaseChatEvent {
  type: 'tool_use';
  toolUseId: string;
  toolName: string;
  input: unknown;
}

export interface ToolResultEvent extends BaseChatEvent {
  type: 'tool_result';
  toolUseId: string;
  content: string;
}

export interface SystemEvent extends BaseChatEvent {
  type: 'system';
  subtype: string;
}

export type ChatEvent = UserEvent | AssistantEvent | ToolUseEvent | ToolResultEvent | SystemEvent;

/** Function returned by tailTranscript that stops watching the file. */
export type StopFn = () => void;

// ─── parseLine ────────────────────────────────────────────────────────────────

/**
 * Parse one raw JSONL line from a Claude Code transcript.
 *
 * Returns a normalised ChatEvent, or null for:
 *  - empty / whitespace-only lines
 *  - partial (malformed JSON) lines
 *  - metadata-only lines (last-prompt, mode, permission-mode, ai-title,
 *    file-history-snapshot, attachment, etc.) that carry no chat content
 */
export function parseLine(rawLine: string): ChatEvent | null {
  const trimmed = rawLine.trim();
  if (!trimmed) return null;

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    // Partial trailing line — buffer, don't emit
    return null;
  }

  const type = obj.type as string | undefined;
  const uuid = (obj.uuid as string | undefined) ?? '';
  const timestamp = (obj.timestamp as string | undefined) ?? '';
  const version = obj.version as string | undefined;

  // ── System lines (compact_boundary, turn_duration, stop_hook_summary…) ──
  if (type === 'system') {
    const subtype = (obj.subtype as string | undefined) ?? '';
    return { type: 'system', subtype, uuid, timestamp, version };
  }

  // ── User lines ─────────────────────────────────────────────────────────────
  if (type === 'user') {
    const msg = obj.message as Record<string, unknown> | undefined;
    if (!msg) return null;

    const content = msg.content;

    // Check if this is a tool_result carrier
    if (Array.isArray(content)) {
      // A user message can carry tool_result blocks
      const firstToolResult = content.find(
        (c: unknown) =>
          typeof c === 'object' &&
          c !== null &&
          (c as Record<string, unknown>).type === 'tool_result',
      ) as Record<string, unknown> | undefined;

      if (firstToolResult) {
        const toolUseId = firstToolResult.tool_use_id as string;
        const resultContent = firstToolResult.content;
        const contentStr =
          typeof resultContent === 'string'
            ? resultContent
            : Array.isArray(resultContent)
              ? (resultContent as Array<Record<string, unknown>>)
                  .map((c) => (c.text as string) ?? '')
                  .join('')
              : JSON.stringify(resultContent);
        return { type: 'tool_result', toolUseId, content: contentStr, uuid, timestamp, version };
      }

      // Plain user message with array content
      const text = content
        .filter(
          (c: unknown) =>
            typeof c === 'object' && c !== null && (c as Record<string, unknown>).type === 'text',
        )
        .map((c: unknown) => ((c as Record<string, unknown>).text as string) ?? '')
        .join('');
      return { type: 'user', text, uuid, timestamp, version };
    }

    // Plain string content
    if (typeof content === 'string') {
      return { type: 'user', text: content, uuid, timestamp, version };
    }

    return null;
  }

  // ── Assistant lines ────────────────────────────────────────────────────────
  if (type === 'assistant') {
    const msg = obj.message as Record<string, unknown> | undefined;
    if (!msg) return null;

    const content = msg.content;
    if (!Array.isArray(content)) return null;

    // Check for tool_use block (first one wins for routing purposes)
    const toolUseBlock = content.find(
      (c: unknown) =>
        typeof c === 'object' && c !== null && (c as Record<string, unknown>).type === 'tool_use',
    ) as Record<string, unknown> | undefined;

    if (toolUseBlock) {
      return {
        type: 'tool_use',
        toolUseId: toolUseBlock.id as string,
        toolName: toolUseBlock.name as string,
        input: toolUseBlock.input,
        uuid,
        timestamp,
        version,
      };
    }

    // Plain text assistant message
    const text = content
      .filter(
        (c: unknown) =>
          typeof c === 'object' && c !== null && (c as Record<string, unknown>).type === 'text',
      )
      .map((c: unknown) => ((c as Record<string, unknown>).text as string) ?? '')
      .join('');
    return { type: 'assistant', text, uuid, timestamp, version };
  }

  // ── All other types (metadata, attachment, etc.) → skip ─────────────────
  return null;
}

// ─── assertTranscriptVersion ──────────────────────────────────────────────────

/**
 * Throw if the observed Claude CLI version has a different major version
 * from what we pinned (2.x.x).  A minor-version bump is fine; a major bump
 * (3.0.0+) signals a potential format break and should fail loudly.
 *
 * Pinned major: 2 (claude 2.1.183, the Phase-0 spike version).
 */
const PINNED_MAJOR = 2;

export function assertTranscriptVersion(version: string): void {
  const major = parseInt(version.split('.')[0] ?? '0', 10);
  if (major !== PINNED_MAJOR) {
    throw new Error(
      `Transcript format version mismatch: expected major ${PINNED_MAJOR}, got ${major} (full: ${version}). ` +
        `Re-run the record-fixtures script and review the transcript normalizer before continuing.`,
    );
  }
}

// ─── tailTranscript ───────────────────────────────────────────────────────────

/**
 * Tail a Claude Code transcript JSONL file.
 *
 * - Reads all complete lines already in the file immediately.
 * - Watches for appended content via fs.watch (change events).
 * - Buffers partial trailing lines (no newline yet) until they complete.
 * - Emits only non-null ChatEvents (metadata/attachment lines are silently skipped).
 * - Returns a StopFn that stops the watcher and clears the buffer.
 *
 * Since compaction is append-only (confirmed by Phase-0 spike), we never need
 * to re-read from offset 0 — a simple byte-offset-advance is correct.
 */
export async function tailTranscript(
  filePath: string,
  onEvent: (event: ChatEvent) => void,
): Promise<StopFn> {
  let offset = 0;
  let buffer = '';
  let watcher: fs.FSWatcher | null = null;
  let stopped = false;

  function readNewContent(): void {
    if (stopped) return;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return; // File may not exist yet
    }

    if (stat.size <= offset) return; // No new bytes

    const fd = fs.openSync(filePath, 'r');
    try {
      const bytesToRead = stat.size - offset;
      const chunk = Buffer.alloc(bytesToRead);
      const bytesRead = fs.readSync(fd, chunk, 0, bytesToRead, offset);
      offset += bytesRead;
      buffer += chunk.slice(0, bytesRead).toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }

    // Process all complete lines (terminated by \n)
    const lines = buffer.split('\n');
    // The last element is either '' (if buffer ends with \n) or a partial line
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = parseLine(line);
        if (event !== null) {
          onEvent(event);
        }
      } catch (err) {
        logger.warn({ err, line: line.slice(0, 120) }, 'transcript: error processing line');
      }
    }
  }

  // Initial read of existing content
  readNewContent();

  // Watch for future appends. `fs.watch` gives low latency but is unreliable on
  // macOS for appends made by another process (claude writes the transcript) —
  // it often does not fire a 'change' event. So we ALSO poll on an interval,
  // which reliably catches every append on all platforms. (Both call the same
  // idempotent offset-advancing reader, so double-firing is harmless.)
  try {
    watcher = fs.watch(filePath, { persistent: false }, (eventType) => {
      if (eventType === 'change' || eventType === 'rename') {
        readNewContent();
      }
    });
    watcher.on('error', (err) => {
      logger.warn({ err, filePath }, 'transcript watcher error');
    });
  } catch (err) {
    logger.warn({ err, filePath }, 'transcript: fs.watch unavailable, relying on poll');
  }

  const TRANSCRIPT_POLL_MS = 250;
  const poll: ReturnType<typeof setInterval> = setInterval(readNewContent, TRANSCRIPT_POLL_MS);
  if (typeof poll.unref === 'function') poll.unref();

  const stop: StopFn = () => {
    stopped = true;
    clearInterval(poll);
    if (watcher) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
      watcher = null;
    }
    buffer = '';
  };

  return stop;
}
