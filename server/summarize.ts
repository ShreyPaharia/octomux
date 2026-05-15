/**
 * C3: Built-in summarize-progress hook.
 *
 * Called fire-and-forget after the Stop hook handler resolves.
 * Reads recent task_updates + permission_prompts, shells out to `claude -p`
 * (Haiku) to produce a one-sentence narrative, writes it to
 * tasks.current_summary, broadcasts, and fires the 'summary_updated' hook.
 * All errors are swallowed.
 */
import { childLogger } from './logger.js';
import { getDb } from './db.js';
import { broadcast } from './events.js';
import { fireHook } from './hook-dispatcher.js';
import { runClaudePrint } from './claude-cli.js';

const logger = childLogger('summarize');

const TIMEOUT_MS = 30_000;
const MAX_TRANSCRIPT_CHARS = 4000;
const BUILTIN_SCOPE = 'builtin';
const BUILTIN_KEY = 'summarize-progress';

const SYSTEM_PROMPT =
  'You are a concise technical summarizer. Return only the requested summary — no preamble, no trailing period unless it ends a sentence.';

/**
 * Check whether the built-in summarize-progress hook is enabled.
 * Default for built-in = disabled (spec: "defaults disabled").
 */
function isBuiltinEnabled(): boolean {
  try {
    const row = getDb()
      .prepare(`SELECT enabled FROM hook_settings WHERE scope = ? AND key = ?`)
      .get(BUILTIN_SCOPE, BUILTIN_KEY) as { enabled: number } | undefined;
    if (row === undefined) return false;
    return row.enabled !== 0;
  } catch {
    return false;
  }
}

/**
 * Build a compact ≤4k char transcript from recent task_updates and
 * permission_prompts rows for the given agent.
 */
function buildTranscript(taskId: string, agentId: string): string {
  const lines: string[] = [];

  try {
    const updates = getDb()
      .prepare(
        `SELECT kind, from_status, to_status, body, created_at
           FROM task_updates
          WHERE task_id = ? AND kind IN ('summary', 'transition', 'note')
          ORDER BY created_at DESC
          LIMIT 30`,
      )
      .all(taskId) as Array<{
      kind: string;
      from_status: string | null;
      to_status: string | null;
      body: string | null;
      created_at: string;
    }>;

    for (const u of updates.reverse()) {
      if (u.kind === 'transition' && u.from_status && u.to_status) {
        lines.push(`[${u.created_at}] transition: ${u.from_status} → ${u.to_status}`);
      } else if (u.body) {
        lines.push(`[${u.created_at}] ${u.kind}: ${u.body}`);
      }
    }

    const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace('T', ' ');
    const prompts = getDb()
      .prepare(
        `SELECT tool_name, tool_input, created_at
           FROM permission_prompts
          WHERE agent_id = ? AND resolved_at IS NOT NULL AND created_at >= ?
          ORDER BY created_at DESC
          LIMIT 10`,
      )
      .all(agentId, tenMinsAgo) as Array<{
      tool_name: string;
      tool_input: string;
      created_at: string;
    }>;

    for (const p of prompts.reverse()) {
      let detail = '';
      try {
        const inp = JSON.parse(p.tool_input) as Record<string, unknown>;
        detail = (inp.command ?? inp.file_path ?? inp.query ?? '') as string;
      } catch {
        // ignore parse errors
      }
      lines.push(`[${p.created_at}] tool: ${p.tool_name}${detail ? ` — ${detail}` : ''}`);
    }
  } catch (err) {
    logger.debug({ task_id: taskId, agent_id: agentId, err }, 'transcript build error');
  }

  const full = lines.join('\n');
  return full.length > MAX_TRANSCRIPT_CHARS ? full.slice(full.length - MAX_TRANSCRIPT_CHARS) : full;
}

/**
 * Fire-and-forget: summarize what the agent just did and write to
 * tasks.current_summary. All errors are swallowed — never bubbles.
 */
export async function summarizeAgentProgress(taskId: string, agentId: string): Promise<void> {
  try {
    if (!isBuiltinEnabled()) return;

    const transcript = buildTranscript(taskId, agentId);
    if (!transcript.trim()) return;

    const prompt = `Summarize what this agent just did in one sentence, ≤120 chars, present tense, no preamble.\n\nAgent activity log:\n${transcript}`;

    const stdout = await runClaudePrint({
      prompt,
      systemPrompt: SYSTEM_PROMPT,
      timeoutMs: TIMEOUT_MS,
    });

    const summary = stdout.slice(0, 120);
    if (!summary) return;

    getDb()
      .prepare(
        `UPDATE tasks
            SET current_summary = ?,
                current_summary_updated_at = datetime('now'),
                updated_at = datetime('now')
          WHERE id = ?`,
      )
      .run(summary, taskId);

    broadcast({ type: 'task:updated', payload: { taskId } });

    void fireHook('summary_updated', {
      event: 'summary_updated',
      task: { id: taskId },
      data: { summary },
    });

    logger.info({ task_id: taskId, agent_id: agentId }, 'progress summary written');
  } catch (err) {
    logger.warn({ task_id: taskId, agent_id: agentId, err }, 'summarizeAgentProgress failed');
  }
}
