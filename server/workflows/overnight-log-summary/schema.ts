/** JSON Schema for the overnight-log-summary submit_result payload. Split out
 * from register.ts so the service can import it without a register<->service
 * import cycle. */
export const OVERNIGHT_LOG_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
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
  },
  required: ['window', 'summary', 'errorClasses', 'notableEvents'],
  additionalProperties: false,
};
