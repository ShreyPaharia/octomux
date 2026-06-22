# Transcript Fixtures — Phase-0 Spike

Captured 2026-06-20 against **claude 2.1.183**.

## Files

- `transcript-2.1.183-basic-qa.jsonl` — Simple Q&A session (5 exchanges).
  Shows user/assistant message format, version field, hook attachment events.
  Session at: `wf_ccfeee3d-5bd-4` worktree (bypassPermissions mode).

- `transcript-2.1.183-with-compaction.jsonl` — Long session with 2 auto-compactions.
  Shows compact_boundary + summary append pattern.

## Key Format Facts (claude 2.1.183)

1. **Append-only**: The file is NEVER rewritten. Compaction appends:
   - `{"type":"system","subtype":"compact_boundary",...}`
   - `{"type":"user","message":{"content":[{"type":"text","text":"This session is being continued..."}]},...}`

2. **Message types**:
   - `type=user`: user prompts (`message.content` = string or array)
   - `type=assistant`: model responses (`message.content` array of text/tool_use/thinking blocks)
   - `type=user` with tool_result content: tool results
   - `type=system subtype=compact_boundary|stop_hook_summary|turn_duration|away_summary`
   - `type=attachment hookName=PreToolUse:Bash|PostToolUse:Read|Stop|UserPromptSubmit|SessionStart...`
   - metadata: `last-prompt`, `mode`, `permission-mode`, `ai-title`, `file-history-snapshot`

3. **Version field**: Present on user/assistant lines. Use for format-change assertion.

   ```json
   {"type":"user","version":"2.1.183",...}
   ```

4. **Hook payload** (from Claude plugin docs):

   ```json
   {
     "session_id": "...",
     "transcript_path": "/path/to/file.jsonl",
     "cwd": "...",
     "hook_event_name": "PreToolUse"
   }
   ```

5. **Transcript path formula**:
   `~/.claude/projects/-<cwd-with-slashes-as-dashes>/<session_id>.jsonl`

## Impact on Build

The spec's §7 warning "Must tolerate compaction _rewrites_" is inaccurate.
Compaction **appends** (compact_boundary marker + summary). The normalizer:

- Can use a simple append-only tail (read-from-offset via FSWatcher)
- Must handle `compact_boundary` lines gracefully (emit a summary event, skip the next user line)
- Does NOT need inotify rewrite detection or file re-opening from offset 0

This simplifies Task 1.3 significantly.
