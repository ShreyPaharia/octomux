import { describe, it, expect, beforeEach, afterEach, vi } from '../../../server/bun-test.js';
import { Command } from 'commander';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerPlugins } from './plugins.js';

function makeProgram(): Command {
  const program = new Command();
  program
    .option('-s, --server-url <url>', 'server URL', 'http://localhost:7777')
    .option('--json', 'output as JSON');
  program.exitOverride();
  registerPlugins(program);
  return program;
}

describe('octomux plugins', () => {
  let tmpDir: string;
  let manifestPath: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-plugins-cli-test-'));
    manifestPath = path.join(tmpDir, 'octomux.yml');
    vi.stubEnv('OCTOMUX_PLUGIN_MANIFEST', manifestPath);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeManifest(yaml: string): void {
    fs.writeFileSync(manifestPath, yaml, 'utf-8');
  }

  function lastJsonLog(): unknown {
    const call = logSpy.mock.calls.at(-1);
    return JSON.parse((call as unknown[])[0] as string);
  }

  it('list --json reflects the manifest on disk', async () => {
    writeManifest(`
plugins:
  - id: demo
    name: demo-plugin
    version: 1.0.0
`);
    const program = makeProgram();
    await program.parseAsync(['node', 'octomux', '--json', 'plugins', 'list']);

    expect(lastJsonLog()).toMatchObject({
      manifestPath,
      plugins: [{ id: 'demo', name: 'demo-plugin', version: '1.0.0' }],
    });
  });

  it('list on a missing manifest reports zero plugins without erroring — never boots the server', async () => {
    const program = makeProgram();
    await program.parseAsync(['node', 'octomux', '--json', 'plugins', 'list']);

    expect(lastJsonLog()).toMatchObject({ manifestPath, plugins: [] });
  });

  it('disable then enable round-trips a plugin row through the YAML file', async () => {
    writeManifest(`
plugins:
  - id: demo
    name: demo-plugin
`);

    let program = makeProgram();
    await program.parseAsync(['node', 'octomux', 'plugins', 'disable', 'demo']);

    let onDisk = fs.readFileSync(manifestPath, 'utf-8');
    expect(onDisk).toContain('disabled: true');

    program = makeProgram();
    await program.parseAsync(['node', 'octomux', '--json', 'plugins', 'list']);
    expect(lastJsonLog()).toMatchObject({ plugins: [{ id: 'demo', disabled: true }] });

    program = makeProgram();
    await program.parseAsync(['node', 'octomux', 'plugins', 'enable', 'demo']);

    onDisk = fs.readFileSync(manifestPath, 'utf-8');
    expect(onDisk).not.toContain('disabled');

    program = makeProgram();
    await program.parseAsync(['node', 'octomux', '--json', 'plugins', 'list']);
    const after = lastJsonLog() as { plugins: Array<{ id: string; disabled?: boolean }> };
    expect(after.plugins[0].disabled).toBeUndefined();
  });

  it('disable on an unknown id exits 1 without touching the file', async () => {
    writeManifest(`
plugins:
  - id: demo
    name: demo-plugin
`);
    const before = fs.readFileSync(manifestPath, 'utf-8');

    const program = makeProgram();
    await expect(
      program.parseAsync(['node', 'octomux', 'plugins', 'disable', 'ghost']),
    ).rejects.toThrow(/process\.exit/);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalled();
    expect(fs.readFileSync(manifestPath, 'utf-8')).toBe(before);
  });
});
