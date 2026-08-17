// octomux-plugin-hello — a minimal, complete plugin.
//
// Registers one integration provider (`notify`) that logs every workflow-status
// change it's configured to react to. No `@octomux/plugin-api` import is needed
// at runtime — it's a types-only package (see the JSDoc types below for the
// shape, or docs/plugins/api-reference.md for the authoritative field list).
//
// The `kinds/hello.json` file next to this one adds a second capability —
// a schedulable "hello" session kind — with zero code: presets are read
// straight off disk, not through apply().

/** @param {import('@octomux/plugin-api').PluginContext} ctx */
export async function apply(ctx) {
  ctx.integrations.register({
    // Local id — octomux stores this as `<manifest-row-id>:notify`, e.g.
    // `hello:notify`. This plugin never sees the qualified form.
    kind: 'notify',
    displayName: 'Hello Notify',
    configSchema: {
      type: 'object',
      properties: { webhookUrl: { type: 'string' } },
      required: ['webhookUrl'],
    },
    events: ['workflow_status_changed'],
    validate(config) {
      const c = /** @type {{ webhookUrl?: unknown }} */ (config ?? {});
      return typeof c.webhookUrl === 'string' && c.webhookUrl.length > 0
        ? { ok: true }
        : { ok: false, errors: ['webhookUrl is required'] };
    },
    async handler(envelope, config) {
      const { webhookUrl } = /** @type {{ webhookUrl: string }} */ (config);
      ctx.logger.info(
        { event: envelope.event, task_id: envelope.task.id, webhookUrl },
        'hello plugin: would POST this event',
      );
      // A real provider would `fetch(webhookUrl, { method: 'POST', body: ... })`
      // here. Left out so this example has no network dependency.
    },
  });

  ctx.logger.info({ pluginId: ctx.id }, 'octomux-plugin-hello: apply() done');
}
