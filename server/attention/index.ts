/**
 * server/attention/index.ts
 *
 * Backs `ctx.attention` (`AttentionApi` in `@octomux/plugin-api` — that
 * doc comment is the spec, read it first). Fans one question out to every
 * registered surface that declares `prompt`, first answer wins, everyone
 * else gets their `signal` aborted.
 *
 * In-memory only, on purpose: a pending ask is a live promise racing live
 * `prompt()` calls, both of which die with the process. Nothing here is
 * persisted, so nothing survives a restart — that is documented behaviour,
 * not a gap. Don't build anything on top of this that must not be lost;
 * that's `server/orchestrator/gate.ts`.
 */
import type { AttentionAsk, AttentionAnswer, SurfacePrompt } from '@octomux/plugin-api';
import { listSurfaces } from '../surfaces/registry.js';
import { childLogger } from '../logger.js';

const logger = childLogger('attention');

/** Default `AttentionAsk.timeoutMs` — 5 minutes, matching `ctx.agents.run`. */
export const DEFAULT_ATTENTION_TIMEOUT_MS = 300_000;

export async function askHumans(ask: AttentionAsk): Promise<AttentionAnswer> {
  const targets = listSurfaces().filter((s) => s.prompt);
  const logFields = ask.taskId ? { task_id: ask.taskId } : {};

  if (targets.length === 0) {
    logger.warn({ ...logFields, question: ask.question }, 'no prompt-capable surface registered');
    return { status: 'unanswerable', answer: ask.defaultAnswer };
  }

  const controller = new AbortController();
  const prompt: SurfacePrompt = {
    taskId: ask.taskId,
    question: ask.question,
    choices: ask.choices,
    signal: controller.signal,
  };

  return new Promise<AttentionAnswer>((resolve) => {
    let settled = false;
    let declined = 0;

    const timer = setTimeout(() => {
      finish({ status: 'timeout', answer: ask.defaultAnswer });
    }, ask.timeoutMs ?? DEFAULT_ATTENTION_TIMEOUT_MS);
    timer.unref?.();

    function finish(answer: AttentionAnswer): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Aborts the WINNER's signal too, not just the losers'. Deliberate: the
      // answer is already in hand, and every surface — including the one that
      // was answered on — wants the same "this question is closed now" signal
      // to clear its message or modal.
      controller.abort();
      resolve(answer);
    }

    for (const s of targets) {
      // `Promise.resolve().then(...)` rather than calling `prompt()` directly:
      // a surface that throws SYNCHRONOUSLY would otherwise escape the .catch
      // below, blow up this executor, and reject an ask that is documented
      // never to reject. Same fail-soft rule as `surfaces/render.ts` — one
      // broken surface must not wedge the question for the others.
      Promise.resolve()
        .then(() => s.prompt!(prompt))
        .then((answer) => {
          if (answer !== undefined) {
            finish({ status: 'answered', answer, surface: s.kind });
            return;
          }
          declined += 1;
          if (declined === targets.length) {
            finish({ status: 'unanswerable', answer: ask.defaultAnswer });
          }
        })
        .catch((err) => {
          logger.warn({ ...logFields, surface_kind: s.kind, err }, 'surface prompt threw');
          declined += 1;
          if (declined === targets.length) {
            finish({ status: 'unanswerable', answer: ask.defaultAnswer });
          }
        });
    }
  });
}
