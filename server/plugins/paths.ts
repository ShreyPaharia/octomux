/**
 * Plugin install paths. Every path here derives from `octomuxRoot()` or an
 * explicit env var — never from `import.meta.url` / `import.meta.dirname`.
 *
 * Verified by spike (plans/2026-08-16-plugin-ecosystem-tasks.md, "S2"): under
 * `bun build --compile`, `import.meta.dirname` is `/$bunfs/root` — the virtual
 * filesystem embedded in the compiled binary, not real disk. A plugin path built
 * from it fails with `Cannot find module '/$bunfs/root/plugins/...'`.
 * `octomuxRoot()` is env-overridable and disk-real (`OCTOMUX_DATA_DIR`, else
 * `os.homedir()`), so everything below composes on top of it. Do not "simplify"
 * this back — it breaks only in the compiled binary, never in dev or under test.
 */
import path from 'path';
import { octomuxRoot } from '../octomux-root.js';

/** Plugin install root. `OCTOMUX_PLUGIN_PREFIX`, else `octomuxRoot()`. */
export function pluginPrefix(): string {
  return process.env.OCTOMUX_PLUGIN_PREFIX || octomuxRoot();
}

/** `<prefix>/node_modules` — the resolution anchor a bare package name resolves
 * against (spike "S1": `createRequire(path.join(pluginModulesDir(), 'anchor.js')).resolve(name)`). */
export function pluginModulesDir(): string {
  return path.join(pluginPrefix(), 'node_modules');
}

/**
 * Where one installed plugin keeps its kind presets: `<modules>/<pkg>/kinds`.
 *
 * Unlike `builtInKindsDir()` / `homeKindsDir()` there is no single flat plugin
 * kinds directory — each package owns its own. The plugin tier enumerates
 * `pluginModulesDir()` and calls this per package it finds.
 */
export function pluginKindsDir(pkg: string): string {
  return path.join(pluginModulesDir(), pkg, 'kinds');
}

/** Manifest path. `OCTOMUX_PLUGIN_MANIFEST`, else `<octomuxRoot()>/octomux.yml`. */
export function manifestPath(): string {
  return process.env.OCTOMUX_PLUGIN_MANIFEST || path.join(octomuxRoot(), 'octomux.yml');
}
