/**
 * server/gateway/condense.ts
 *
 * Guard for every outbound gateway chat message (Slack/Telegram): replace raw
 * structured-artifact payloads with a readable summary before send. Applied at
 * the single OutboundQueue seam in gateway.ts, so turn replies, supervisor
 * pushes, and any future adapter are all covered.
 *
 *  - plan.json-shaped blobs (validated with the existing validatePlanJson) are
 *    rendered from their own summary/files/open_questions fields — no LLM call.
 *  - other large JSON blobs are collapsed to a one-line marker.
 *  - anything still over CHAT_MAX_CHARS is truncated with a clear marker
 *    (Telegram hard-fails above 4096 chars; the user reads on mobile anyway).
 */

import { childLogger } from '../logger.js';
import { validatePlanJson } from '../orchestrator/exec.js';

const logger = childLogger('gateway-condense');

/** Under Telegram's 4096 hard limit; deliberately also applied to Slack. */
export const CHAT_MAX_CHARS = 3900;

/** Bare {...} spans shorter than this are never treated as artifact candidates. */
const MIN_BARE_SPAN_CHARS = 400;

/** Non-plan JSON blobs shorter than this pass through untouched. */
const MIN_GENERIC_BLOB_CHARS = 500;

const MAX_LISTED_KEYS = 8;

interface PlanFileEntry {
  path: string;
  action: string;
}

/** Render a validated plan from its own fields; steps/detail are dropped. */
function renderPlan(plan: Record<string, unknown>): string {
  const lines = [`📋 Plan: ${(plan['summary'] as string).trim()}`];
  const files = plan['files'] as PlanFileEntry[];
  if (files.length > 0) {
    lines.push('', 'Files:');
    for (const f of files) lines.push(`• ${f.path} (${f.action})`);
  }
  const questions = plan['open_questions'] as string[] | undefined;
  if (questions && questions.length > 0) {
    lines.push('', 'Open questions:');
    for (const q of questions) lines.push(`• ${q}`);
  }
  return lines.join('\n');
}

function renderGeneric(parsed: Record<string, unknown>, rawLength: number): string {
  const keys = Object.keys(parsed);
  const listed =
    keys.slice(0, MAX_LISTED_KEYS).join(', ') + (keys.length > MAX_LISTED_KEYS ? ', …' : '');
  const kb = (rawLength / 1024).toFixed(1);
  const gist = ['summary', 'title'].map((k) => parsed[k]).find((v) => typeof v === 'string') as
    | string
    | undefined;
  const marker = `[structured payload condensed — ${kb} KB, keys: ${listed}]`;
  return gist ? `${marker}\n${gist}` : marker;
}

/**
 * Condense one JSON candidate. Returns the replacement text, or null to leave
 * the original untouched (not JSON, or too small to be worth collapsing).
 */
function condenseBlob(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    if (raw.length < MIN_GENERIC_BLOB_CHARS) return null;
    return `[structured payload condensed — ${(raw.length / 1024).toFixed(1)} KB]`;
  }
  const obj = parsed as Record<string, unknown>;
  if (validatePlanJson(obj).valid) return renderPlan(obj);
  if (raw.length < MIN_GENERIC_BLOB_CHARS) return null;
  return renderGeneric(obj, raw.length);
}

/**
 * Replace fenced code blocks whose body is a condensable JSON payload.
 * The closing fence must sit at the start of a line — a JSON string literal
 * can't contain a real newline, so lazy matching can't stop early on a
 * ``` embedded inside the payload's strings.
 */
function replaceFencedBlobs(text: string): string {
  return text.replace(/```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n```/g, (fence, body: string) => {
    const replacement = condenseBlob(body.trim());
    return replacement ?? fence;
  });
}

/**
 * Find the index of the `}` closing the `{` at `start`, honouring JSON string
 * literals and escapes. Returns -1 when unbalanced.
 */
function matchBraces(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Replace bare (unfenced) {...} spans that are condensable JSON payloads. */
function replaceBareBlobs(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '{') {
      out += text[i];
      i++;
      continue;
    }
    const end = matchBraces(text, i);
    if (end === -1) {
      out += text.slice(i);
      break;
    }
    const span = text.slice(i, end + 1);
    const replacement = span.length >= MIN_BARE_SPAN_CHARS ? condenseBlob(span) : null;
    out += replacement ?? span;
    i = end + 1;
  }
  return out;
}

/**
 * Condense structured-artifact payloads in an outbound chat message and cap
 * its length. Idempotent on ordinary prose.
 */
export function condenseForChat(text: string): string {
  let out = replaceBareBlobs(replaceFencedBlobs(text));
  if (out !== text) {
    logger.info(
      { before_chars: text.length, after_chars: out.length },
      'condensed structured payload in outbound chat message',
    );
  }
  if (out.length > CHAT_MAX_CHARS) {
    const omitted = out.length - CHAT_MAX_CHARS;
    logger.info(
      { message_chars: out.length, omitted_chars: omitted },
      'truncated outbound chat message',
    );
    out = `${out.slice(0, CHAT_MAX_CHARS)}\n… [truncated, ${omitted} chars omitted]`;
  }
  return out;
}
