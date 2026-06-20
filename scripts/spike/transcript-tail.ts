/**
 * transcript-tail.ts — Phase-0 spike: Task 0.1
 *
 * FINDINGS (2026-06-20, claude 2.1.183):
 *
 * VERDICT: PARTIAL → architecture simplifies
 *
 * 1. TRANSCRIPT FORMAT VERIFIED:
 *    - Path from hooks: transcript_path in hook payload stdin JSON
 *    - Path formula: ~/.claude/projects/-<cwd-with-slashes-as-dashes>/<session_id>.jsonl
 *    - File is APPEND-ONLY (not rewritten on compaction)
 *
 * 2. COMPACTION IS APPEND-ONLY (spec assumption was wrong):
 *    - type=system subtype=compact_boundary line marks the boundary
 *    - Followed immediately by type=user with summary text:
 *      "This session is being continued from a previous conversation..."
 *    - NO file rewrite occurs. Tailing works unchanged.
 *    - The normalizer does NOT need rewrite/re-sync logic.
 *    - "PreCompact" hook exists (fires before compaction, for context preservation).
 *    - "PostCompact" hook exists (fires after, added in recent version).
 *    - Neither rewrites the file.
 *
 * 3. MESSAGE TYPES (observed in 2.1.183):
 *    - type=user: user prompts (message.content string or array; version field present)
 *    - type=assistant: model responses (message.content array; message.id; usage)
 *    - type=system subtype=compact_boundary|stop_hook_summary|turn_duration|away_summary
 *    - type=attachment: hook events (hookName: PreToolUse:Bash, PostToolUse:Read, Stop, etc.)
 *    - type=last-prompt, type=mode, type=permission-mode, type=ai-title (metadata)
 *    - type=file-history-snapshot, type=queue-operation (session mgmt)
 *
 * 4. VERSION ASSERTION:
 *    - "version" field present on user/assistant lines (e.g. "2.1.183")
 *    - First line with version = first user message in the session
 *    - Use this for format-change detection
 *
 * 5. FIRST-RUN TUI DIALOGS:
 *    - Trust dialog: skipped with --dangerously-skip-permissions (existing harness flag)
 *    - Theme dialog: not encountered in bypassPermissions mode sessions
 *    - Onboarding: handled by existing harness (already using bypassPermissions)
 *    - The existing claude-code harness + dangerouslySkipPermissions ALREADY handles this
 *    - No additional work required beyond what the worker harness already does
 *
 * 6. HOOK transcript_path FIELD:
 *    - Documented in plugin-dev hook-development skill:
 *      { session_id, transcript_path, cwd, permission_mode, hook_event_name }
 *    - Available in ALL hook events (PreToolUse, PostToolUse, Stop, UserPromptSubmit, etc.)
 *    - Can be captured from the first hook event after session start
 *
 * IMPACT ON BUILD:
 * - Simpler normalizer: pure append-only tail; compact_boundary is just a marker line
 * - No inotify/FSWatcher rewrite detection needed; fs.watch + read-from-offset is sufficient
 * - The spec's §7 "Must tolerate compaction rewrites" is OVERSTATED:
 *   compaction appends, it doesn't rewrite. The normalizer just needs to handle
 *   compact_boundary lines gracefully (treat them as a session-summary event type).
 */

import * as fs from 'fs';
import * as _readline from 'readline';
import * as path from 'path';
import * as os from 'os';

export type TranscriptEvent =
  | { type: 'user'; text: string; timestamp?: string; version?: string }
  | { type: 'assistant'; text: string; toolUses?: ToolUse[]; timestamp?: string }
  | { type: 'tool_result'; toolUseId: string; content: string }
  | { type: 'compact_boundary'; summaryText: string }
  | { type: 'system'; subtype: string; data: unknown }
  | { type: 'unknown'; raw: unknown };

export interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

/** Parse a raw JSONL line into a normalized TranscriptEvent */
export function parseLine(raw: string): TranscriptEvent | null {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(raw);
  } catch {
    return null; // partial trailing line
  }

  const type = d.type as string;

  if (type === 'user') {
    const msg = d.message as { role?: string; content?: unknown } | undefined;
    const content = msg?.content;
    if (typeof content === 'string') {
      return {
        type: 'user',
        text: content,
        timestamp: d.timestamp as string,
        version: d.version as string,
      };
    }
    if (Array.isArray(content)) {
      // tool_result messages
      for (const item of content) {
        if (
          item &&
          typeof item === 'object' &&
          (item as Record<string, unknown>).type === 'tool_result'
        ) {
          const tr = item as Record<string, unknown>;
          return {
            type: 'tool_result',
            toolUseId: tr.tool_use_id as string,
            content: tr.content as string,
          };
        }
        if (item && typeof item === 'object' && (item as Record<string, unknown>).type === 'text') {
          // Summary text after compact_boundary
          return {
            type: 'user',
            text: (item as Record<string, unknown>).text as string,
            timestamp: d.timestamp as string,
          };
        }
      }
    }
  }

  if (type === 'assistant') {
    const msg = d.message as { content?: unknown } | undefined;
    const content = msg?.content;
    const texts: string[] = [];
    const toolUses: ToolUse[] = [];
    if (Array.isArray(content)) {
      for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        const block = item as Record<string, unknown>;
        if (block.type === 'text') texts.push(block.text as string);
        if (block.type === 'tool_use') {
          toolUses.push({ id: block.id as string, name: block.name as string, input: block.input });
        }
      }
    }
    return {
      type: 'assistant',
      text: texts.join(''),
      toolUses: toolUses.length > 0 ? toolUses : undefined,
      timestamp: d.timestamp as string,
    };
  }

  if (type === 'system') {
    return { type: 'system', subtype: d.subtype as string, data: d };
  }

  return { type: 'unknown', raw: d };
}

/** Assert the transcript format version. Throws if it drifts from expectedVersion. */
export function assertTranscriptVersion(event: TranscriptEvent, expectedVersion: string): void {
  if (event.type === 'user' && event.version && event.version !== expectedVersion) {
    throw new Error(
      `Transcript format version mismatch: expected ${expectedVersion}, got ${event.version}. ` +
        'Update fixtures and re-run record-fixtures.ts.',
    );
  }
}

/** Compute the transcript file path from a cwd and session_id. */
export function transcriptPath(sessionId: string, cwd: string): string {
  const encodedCwd = cwd.replace(/\//g, '-').replace(/^-/, '');
  return path.join(os.homedir(), '.claude', 'projects', `-${encodedCwd}`, `${sessionId}.jsonl`);
}

/**
 * Tail a transcript JSONL file, emitting normalized events.
 * Handles partial trailing lines and compact_boundary markers.
 * Does NOT need rewrite handling — the file is append-only.
 * Returns a cleanup function.
 */
export function tailTranscript(
  filePath: string,
  onEvent: (event: TranscriptEvent) => void,
): () => void {
  let offset = 0;
  let pendingLine = '';
  let pendingCompactBoundary = false;
  let watcher: fs.FSWatcher | null = null;

  function readNewLines() {
    const fd = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      if (stat.size <= offset) return;
      const buf = Buffer.alloc(stat.size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      offset = stat.size;

      const text = pendingLine + buf.toString('utf-8');
      const lines = text.split('\n');
      pendingLine = lines.pop() ?? ''; // last partial line

      for (const line of lines) {
        if (!line.trim()) continue;
        const event = parseLine(line);
        if (!event) continue;

        // Handle compact_boundary: next user message is the summary
        if (
          event.type === 'system' &&
          (event as { subtype: string }).subtype === 'compact_boundary'
        ) {
          pendingCompactBoundary = true;
          continue;
        }
        if (pendingCompactBoundary && event.type === 'user') {
          onEvent({ type: 'compact_boundary', summaryText: event.text });
          pendingCompactBoundary = false;
          continue;
        }
        pendingCompactBoundary = false;

        onEvent(event);
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  // Initial read from beginning
  readNewLines();

  // Watch for appends
  try {
    watcher = fs.watch(filePath, (eventType) => {
      if (eventType === 'change') readNewLines();
    });
  } catch {
    // File not yet available; caller should retry
  }

  return () => {
    watcher?.close();
  };
}
