import type { TaskExternalRef } from './types.js';

export interface RefInferenceRule {
  integration: string;
  pattern: string;
  url_template?: string;
}

export interface RepoConfigWithInference {
  repo_path: string;
  ref_inference_json?: string | null;
}

/**
 * Parse the `ref_inference_json` column.  Returns an empty array on any parse
 * error — never throws.
 */
export function parseRefInferenceRules(json: string | null | undefined): RefInferenceRule[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is RefInferenceRule =>
        typeof r === 'object' &&
        r !== null &&
        typeof r.integration === 'string' &&
        typeof r.pattern === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * Pure function: given a branch name and a repo config, return the list of
 * TaskExternalRef objects that should be inferred.  No DB writes; caller decides
 * which refs to persist.
 *
 * - First match per integration wins.
 * - `url_template` may contain `{ref}` which is replaced by the capture group.
 */
export function inferRefs(
  branch: string,
  config: RepoConfigWithInference,
  taskId: string,
): TaskExternalRef[] {
  const rules = parseRefInferenceRules(config.ref_inference_json);
  if (rules.length === 0) return [];

  const seenIntegrations = new Set<string>();
  const results: TaskExternalRef[] = [];

  for (const rule of rules) {
    if (seenIntegrations.has(rule.integration)) continue;
    let regex: RegExp;
    try {
      regex = new RegExp(rule.pattern);
    } catch {
      // Invalid pattern — skip
      continue;
    }
    const match = branch.match(regex);
    if (!match) continue;

    // Use first capture group if present, otherwise the full match
    const ref = match[1] ?? match[0];
    const url = rule.url_template ? rule.url_template.replace('{ref}', ref) : undefined;

    seenIntegrations.add(rule.integration);
    results.push({
      task_id: taskId,
      integration: rule.integration,
      ref,
      url: url ?? null,
      metadata: null,
      created_at: new Date().toISOString(),
    });
  }

  return results;
}
