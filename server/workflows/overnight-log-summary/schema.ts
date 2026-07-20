/** JSON Schema for the overnight-log-summary submit_result payload. Split out
 * from register.ts so the service can import it without a register<->service
 * import cycle.
 *
 * `outcome` + `links` are the universal run-result envelope (see
 * `RUN_RESULT_SCHEMA` in @octomux/types, spec/workflow-consolidation.md §5).
 * `summary` already existed here and means the same thing as the envelope's
 * `summary` — reused, not duplicated. */
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
