/** JSON Schema for doc-drift schedule instance config. */
export const DOC_DRIFT_CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    verify: {
      type: 'string',
      title: 'Verify command',
      description:
        'Shell command that exits 0 when doc-drift work is complete (scoped to the task branch).',
      default:
        '[ -n "$(git diff --name-only origin/HEAD... -- \'*.md\' 2>/dev/null)" ] && [ -n "$(gh pr list --head "$(git rev-parse --abbrev-ref HEAD)" --state open --json number --jq \'.[0].number\')" ]',
    },
    maxIterations: {
      type: 'integer',
      title: 'Max iterations',
      minimum: 1,
      default: 4,
    },
    baseBranch: {
      type: 'string',
      title: 'Base branch',
      default: 'main',
      format: 'single-line',
      pattern: '^[a-zA-Z0-9._/-]{1,80}$',
    },
    branchPrefix: {
      type: 'string',
      title: 'Branch prefix',
      default: 'doc-drift',
      format: 'single-line',
      pattern: '^[a-zA-Z0-9._/-]{1,80}$',
    },
  },
  additionalProperties: false,
};
