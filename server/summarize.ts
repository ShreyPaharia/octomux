/**
 * C3: Built-in summarize-progress hook.
 *
 * Called fire-and-forget after the Stop hook handler resolves.
 * Reads recent task_updates + permission_prompts, calls Haiku to produce a
 * one-sentence narrative, writes it to tasks.current_summary, broadcasts, and
 * fires the 'summary_updated' hook. All errors are swallowed.
 */
import { childLogger } from './logger.js';
import { getDb } from './db.js';
import { broadcast } from './events.js';
import { fireHook } from './hook-dispatcher.js';

const logger = childLogger('summarize');

const MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 8000;
const MAX_TRANSCRIPT_CHARS = 4000;
const BUILTIN_SCOPE = 'builtin';
const BUILTIN_KEY = 'summarize-progress';

/**
 * Check whether the built-in summarize-progress hook is enabled.
 * Default for built-in = disabled (spec: "defaults disabled").
 */
function isBuiltinEnabled(): boolean {
  try {
    const row = getDb()
      .prepare(`SELECT enabled FROM hook_settings WHERE scope = ? AND key = ?`)
      .get(BUILTIN_SCOPE, BUILTIN_KEY) as { enabled: number } | undefined;
    // Missing row → disabled (built-in exception to the "missing = enabled" rule)
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
    // Last 30 task_updates rows (summary / transition / note kinds)
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

    // Permission prompts resolved in the last 10 minutes
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
  // Trim to MAX_TRANSCRIPT_CHARS from the END (most recent events are most useful)
  return full.length > MAX_TRANSCRIPT_CHARS ? full.slice(full.length - MAX_TRANSCRIPT_CHARS) : full;
}

/**
 * Fire-and-forget: summarize what the agent just did and write to
 * tasks.current_summary. All errors are swallowed — never bubbles.
 */
export async function summarizeAgentProgress(taskId: string, agentId: string): Promise<void> {
  try {
    // 1. Guard: must be enabled AND have an API key
    if (!isBuiltinEnabled()) return;
    if (!process.env.ANTHROPIC_API_KEY) return;

    const transcript = buildTranscript(taskId, agentId);
    if (!transcript.trim()) return;

    // 2. Call Haiku with timeout
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let summary: string;
    try {
      const response = await client.messages.create(
        {
          model: MODEL,
          max_tokens: 150,
          system:
            'You are a concise technical summarizer. Return only the requested summary — no preamble, no trailing period unless it ends a sentence.',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `Summarize what this agent just did in one sentence, ≤120 chars, present tense, no preamble.\n\nAgent activity log:\n${transcript}`,
                  cache_control: { type: 'ephemeral' },
                },
              ],
            },
          ],
        },
        { signal: controller.signal },
      );
      clearTimeout(timer);

      const text = response.content[0]?.type === 'text' ? (response.content[0].text ?? '') : '';
      summary = text.trim().slice(0, 120);
    } catch (innerErr) {
      clearTimeout(timer);
      throw innerErr;
    }

    if (!summary) return;

    // 3. Write to tasks.current_summary
    getDb()
      .prepare(
        `UPDATE tasks
            SET current_summary = ?,
                current_summary_updated_at = datetime('now'),
                updated_at = datetime('now')
          WHERE id = ?`,
      )
      .run(summary, taskId);

    // 4. Broadcast
    broadcast({ type: 'task:updated', payload: { taskId } });

    // 5. Fire summary_updated hook
    void fireHook('summary_updated', {
      event: 'summary_updated',
      task: { id: taskId },
      data: { summary },
    });

    logger.info({ task_id: taskId, agent_id: agentId }, 'progress summary written');
  } catch (err) {
    // All errors swallowed — never propagate
    logger.warn({ task_id: taskId, agent_id: agentId, err }, 'summarizeAgentProgress failed');
  }
}
