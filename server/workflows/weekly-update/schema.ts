/** JSON Schema for the weekly-update submit_result payload. Split out from
 * register.ts so the service can import it without a register<->service
 * import cycle.
 *
 * `outcome` + `summary` + `links` are the universal run-result envelope (see
 * `RUN_RESULT_SCHEMA` in @octomux/types, spec/workflow-consolidation.md §5).
 * Unlike overnight-log-summary, this kind never had its own `summary` field,
 * so it's added here rather than reused. */
export const WEEKLY_UPDATE_SCHEMA = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['done', 'blocked', 'failed'] },
    summary: { type: 'string' },
    period: { type: 'string' },
    themes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          items: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'items'],
        additionalProperties: false,
      },
    },
    highlights: { type: 'array', items: { type: 'string' } },
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
  required: ['outcome', 'summary', 'period', 'themes', 'highlights'],
  additionalProperties: false,
};
