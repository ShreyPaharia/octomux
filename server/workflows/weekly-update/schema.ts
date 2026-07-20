/** JSON Schema for the weekly-update submit_result payload. Split out from
 * register.ts so the service can import it without a register<->service
 * import cycle. */
export const WEEKLY_UPDATE_SCHEMA = {
  type: 'object',
  properties: {
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
  },
  required: ['period', 'themes', 'highlights'],
  additionalProperties: false,
};
