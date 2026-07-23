import { getSettings } from './settings.js';
import { appendOctomuxPluginFlags, type OctomuxPluginFlagOpts } from './octomux-plugin.js';
import type { Harness } from './harnesses/types.js';

/** Resolve harness flags with the bundled octomux plugin (and optional skill overrides). */
export async function resolveHarnessFlags(
  harness: Harness,
  pluginOpts?: OctomuxPluginFlagOpts,
): Promise<string> {
  const base = harness.resolveFlags(await getSettings());
  return appendOctomuxPluginFlags(base, pluginOpts);
}
