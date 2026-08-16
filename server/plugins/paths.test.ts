import { describe, it, expect, afterEach, vi } from '../bun-test.js';
import path from 'path';
import { octomuxRoot } from '../octomux-root.js';
import { pluginPrefix, pluginModulesDir, pluginKindsDir, manifestPath } from './paths.js';

describe('plugin paths', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('defaults (no env override)', () => {
    it('pluginPrefix lands under octomuxRoot()', () => {
      expect(pluginPrefix()).toBe(octomuxRoot());
    });

    it('pluginModulesDir is <prefix>/node_modules', () => {
      expect(pluginModulesDir()).toBe(path.join(octomuxRoot(), 'node_modules'));
    });

    it('pluginKindsDir is <modules>/<pkg>/kinds', () => {
      expect(pluginKindsDir('octomux-plugin-demo')).toBe(
        path.join(pluginModulesDir(), 'octomux-plugin-demo', 'kinds'),
      );
    });

    it('manifestPath is <octomuxRoot()>/octomux.yml', () => {
      expect(manifestPath()).toBe(path.join(octomuxRoot(), 'octomux.yml'));
    });
  });

  describe('env overrides', () => {
    it('OCTOMUX_PLUGIN_PREFIX overrides pluginPrefix and every path built on it', () => {
      vi.stubEnv('OCTOMUX_PLUGIN_PREFIX', '/tmp/octomux-plugin-test-prefix');
      expect(pluginPrefix()).toBe('/tmp/octomux-plugin-test-prefix');
      expect(pluginModulesDir()).toBe('/tmp/octomux-plugin-test-prefix/node_modules');
      expect(pluginKindsDir('p')).toBe('/tmp/octomux-plugin-test-prefix/node_modules/p/kinds');
    });

    it('OCTOMUX_PLUGIN_MANIFEST overrides manifestPath outright', () => {
      vi.stubEnv('OCTOMUX_PLUGIN_MANIFEST', '/tmp/custom-manifest.yml');
      expect(manifestPath()).toBe('/tmp/custom-manifest.yml');
    });

    it('OCTOMUX_PLUGIN_MANIFEST is independent of OCTOMUX_PLUGIN_PREFIX', () => {
      vi.stubEnv('OCTOMUX_PLUGIN_PREFIX', '/tmp/octomux-plugin-test-prefix');
      vi.stubEnv('OCTOMUX_PLUGIN_MANIFEST', '/tmp/custom-manifest.yml');
      expect(manifestPath()).toBe('/tmp/custom-manifest.yml');
      expect(pluginPrefix()).toBe('/tmp/octomux-plugin-test-prefix');
    });
  });
});
