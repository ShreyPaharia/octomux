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
import { broadcast } from './events.js';
import { fireHook } from './hook-dispatcher.js';
import { runClaudePrint } from './claude-cli.js';
import {
  getHookEnabled,
  listTaskUpdatesForTranscript,
  listRecentResolvedByAgent,
  setCurrentSummary,
} from './repositories/index.js';

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
  return getHookEnabled(BUILTIN_SCOPE, BUILTIN_KEY, false);
}

/**
 * Build a compact ≤4k char transcript from recent task_updates and
 * permission_prompts rows for the given agent.
 */
function buildTranscript(taskId: string, agentId: string): string {
  const lines: string[] = [];

  try {
    const updates = listTaskUpdatesForTranscript(taskId, 30);

    for (const u of updates.reverse()) {
      if (u.kind === 'transition' && u.from_status && u.to_status) {
        lines.push(`[${u.created_at}] transition: ${u.from_status} → ${u.to_status}`);
      } else if (u.body) {
        lines.push(`[${u.created_at}] ${u.kind}: ${u.body}`);
      }
    }

    const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace('T', ' ');
    const prompts = listRecentResolvedByAgent(agentId, tenMinsAgo, 10);

    for (const p of prompts.reverse()) {
      let detail = '';
      try {
        const inp = p.tool_input;
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

    setCurrentSummary(taskId, summary);

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
