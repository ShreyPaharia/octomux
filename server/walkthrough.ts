import type { Walkthrough, PRType, FileLabel } from './types.js';

const PR_TYPES: PRType[] = ['Bug fix', 'Tests', 'Enhancement', 'Documentation', 'Other'];
const FILE_LABELS: FileLabel[] = [
  'bug fix',
  'tests',
  'enhancement',
  'documentation',
  'error handling',
  'configuration changes',
  'dependencies',
  'formatting',
  'miscellaneous',
];
const RISKS = ['low', 'medium', 'high'] as const;
const TESTS = ['yes', 'no', 'partial'] as const;

export type ValidateResult =
  | { ok: true; orphans: string[] }
  | { ok: false; errors: string[]; orphans: string[] };

/**
 * Validate a candidate walkthrough JSON against the diff file list.
 *
 * `diffFiles` is the unique list of files changed in `<base>..<head>` (in PR-head terms).
 * Returns orphans (diff files not placed into any group) so the caller can synthesize
 * an "Other changes" group.
 */
export function validateWalkthrough(input: unknown, diffFiles: string[]): ValidateResult {
  const errors: string[] = [];

  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['walkthrough must be an object'], orphans: [] };
  }
  const wt = input as Walkthrough;

  if (!wt.global || typeof wt.global !== 'object') {
    errors.push('global is required');
  } else {
    if (!PR_TYPES.includes(wt.global.type)) {
      errors.push(`global.type must be one of: ${PR_TYPES.join(', ')}`);
    }
    if (!(RISKS as readonly string[]).includes(wt.global.risk)) {
      errors.push(`global.risk must be one of: ${RISKS.join(', ')}`);
    }
    if (![1, 2, 3, 4, 5].includes(wt.global.effort as number)) {
      errors.push('global.effort must be 1, 2, 3, 4, or 5');
    }
    if (!(TESTS as readonly string[]).includes(wt.global.relevant_tests)) {
      errors.push(`global.relevant_tests must be one of: ${TESTS.join(', ')}`);
    }
    if (wt.global.security_concerns !== null && typeof wt.global.security_concerns !== 'string') {
      errors.push('global.security_concerns must be string or null');
    }
    if (!Array.isArray(wt.global.ticket_compliance)) {
      errors.push('global.ticket_compliance must be an array');
    }
    if (typeof wt.global.summary !== 'string') {
      errors.push('global.summary must be a string');
    }
    if (!Array.isArray(wt.global.key_review_points)) {
      errors.push('global.key_review_points must be an array of strings');
    }
  }

  if (!Array.isArray(wt.groups)) {
    errors.push('groups must be an array');
  }

  const allListedPaths = new Set<string>();
  const diffSet = new Set(diffFiles);
  const groups = Array.isArray(wt.groups) ? wt.groups : [];
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    if (!g || typeof g.name !== 'string' || !Array.isArray(g.files)) {
      errors.push(`groups[${gi}] must have a name and a files array`);
      continue;
    }
    for (let fi = 0; fi < g.files.length; fi++) {
      const f = g.files[fi];
      if (!f || typeof f.path !== 'string' || !FILE_LABELS.includes(f.label)) {
        errors.push(
          `groups[${gi}].files[${fi}] must have a path and a valid label (one of ${FILE_LABELS.join(', ')})`,
        );
        continue;
      }
      if (!diffSet.has(f.path)) {
        errors.push(`hallucinated file path: ${f.path} (groups[${gi}].files[${fi}])`);
      }
      allListedPaths.add(f.path);
    }
  }

  const orphans = diffFiles.filter((p) => !allListedPaths.has(p));

  if (errors.length > 0) return { ok: false, errors, orphans };
  return { ok: true, orphans };
}

/** Append an auto-generated "Other changes" group covering orphan paths. */
export function appendOrphansGroup(wt: Walkthrough, orphans: string[]): Walkthrough {
  if (orphans.length === 0) return wt;
  return {
    ...wt,
    groups: [
      ...wt.groups,
      {
        name: 'Other changes',
        summary:
          "Files not covered by the agent's grouping. Often lockfiles, config touch-ups, or trivial edits.",
        files: orphans.map((path) => ({ path, label: 'miscellaneous', summary: '' })),
      },
    ],
  };
}
