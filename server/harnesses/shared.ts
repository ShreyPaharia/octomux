import fs from 'fs';
import type { HarnessLaunchOpts, HarnessResumeOpts } from './types.js';
import { validateAgentName } from './types.js';
import { shellQuoteSingle } from '../shell-quote.js';

/** Canonical JSON settings/config serialization (trailing newline). */
export function formatJsonConfig(obj: unknown): string {
  return JSON.stringify(obj, null, 2) + '\n';
}

/** Write a JSON config file using the canonical harness serialization format. */
export function writeJsonConfig(
  filePath: string,
  obj: unknown,
  options?: fs.WriteFileOptions,
): void {
  fs.writeFileSync(filePath, formatJsonConfig(obj), options);
}

/** Join validated flag tokens with a leading space, or return '' when empty. */
export function formatHarnessFlags(parts: string[]): string {
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

/** Strip any existing --model <value> from a flags string, then append --model <model>. */
export function applyModel(flags: string, model: string | null | undefined): string {
  if (!model) return flags;
  const stripped = flags.replace(/\s*--model\s+\S+/g, '');
  return `${stripped} --model ${shellQuoteSingle(model)}`;
}

export type SettingsFieldValidator = (value: unknown) => unknown;

export interface ValidateSettingsObjectOptions {
  /** When true, reject keys not listed in `fields`. */
  rejectUnknownKeys?: boolean;
}

/**
 * Validate a harness settings sub-object. Only keys present on the input blob
 * are validated and copied to the output; absent keys are omitted.
 */
export function validateSettingsObject(
  blob: unknown,
  harnessLabel: string,
  fields: Record<string, SettingsFieldValidator>,
  options?: ValidateSettingsObjectOptions,
): Record<string, unknown> {
  if (typeof blob !== 'object' || blob === null || Array.isArray(blob)) {
    throw new Error(`Invalid ${harnessLabel} settings: expected object`);
  }
  const obj = blob as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  if (options?.rejectUnknownKeys) {
    const allowed = new Set(Object.keys(fields));
    for (const key of Object.keys(obj)) {
      if (!allowed.has(key)) {
        throw new Error(`Invalid ${harnessLabel} settings: unknown key "${key}"`);
      }
    }
  }

  for (const [key, validator] of Object.entries(fields)) {
    if (obj[key] !== undefined) {
      const validated = validator(obj[key]);
      if (validated !== undefined) {
        out[key] = validated;
      }
    }
  }
  return out;
}

/** Normalize resolved flags to a single leading-space-separated string (or ''),
 *  so callers can't accidentally glue flags onto the preceding token (e.g. the
 *  session id) by passing flags without/with-stray leading whitespace. */
function flagsSuffix(flags: string, model: string | null | undefined): string {
  const resolved = applyModel(flags, model).trim();
  return resolved ? ` ${resolved}` : '';
}

export function buildClaudeLaunchCommand({
  sessionId,
  agent,
  flags = '',
  model,
}: HarnessLaunchOpts): string {
  const agentPart = agent ? ` --agent ${validateAgentName(agent)}` : '';
  return `claude${agentPart} --session-id ${sessionId}${flagsSuffix(flags, model)}`;
}

export function buildClaudeResumeCommand({
  sessionId,
  flags = '',
  model,
}: HarnessResumeOpts): string {
  return `claude --resume ${sessionId}${flagsSuffix(flags, model)}`;
}

export function buildClaudeContinueCommand({
  sessionId,
  flags = '',
  model,
}: HarnessResumeOpts): string {
  return `claude --continue --session-id ${sessionId}${flagsSuffix(flags, model)}`;
}
