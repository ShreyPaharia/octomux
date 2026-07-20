/** JSON Schema for the overnight-log-summary submit_result payload. Split out
 * from index.ts so run.ts can import it without a circular dependency.
 *
 * `outcome` + `links` are the universal run-result envelope (see
 * `RUN_RESULT_SCHEMA` in @octomux/types, spec/workflow-consolidation.md §5).
 * `summary` already existed here and means the same thing as the envelope's
 * `summary` — reused, not duplicated. */
export const OVERNIGHT_LOG_SUMMARY_CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    logCommand: {
      type: 'string',
      title: 'Log command',
      description: 'Command whose output the summary agent inspects.',
      default: 'gh run list --limit 30 --json databaseId,conclusion,name,url',
    },
  },
  additionalProperties: false,
};

export const OVERNIGHT_LOG_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['done', 'blocked', 'failed'] },
    window: { type: 'string' },
    summary: { type: 'string' },
    errorClasses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          count: { type: 'number' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['name', 'count', 'severity'],
        additionalProperties: false,
      },
    },
    notableEvents: { type: 'array', items: { type: 'string' } },
    links: {
      type: 'array',
      items: {
        type: 'object',
        required: ['label', 'url'],
        properties: { label: { type: 'string' }, url: { type: 'string' } },
        additionalProperties: false,
      },
    },
  },
  required: ['outcome', 'window', 'summary', 'errorClasses', 'notableEvents'],
  additionalProperties: false,
};
