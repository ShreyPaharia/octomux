import { describe, it, expect, beforeEach, afterEach, vi } from '../../../server/bun-test.js';
import { Command } from 'commander';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerPlugins } from './plugins.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

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
    mockFetch.mockReset();
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

  it('refuses to write a config value that would round-trip into an unparseable manifest', async () => {
    // A config string with a newline immediately followed by "&" parses in
    // fine (it's a quoted scalar), but `yaml.dump` re-emits it as an
    // unquoted block scalar on the way out, which the manifest's
    // anchor/alias guard then rejects on the next read. Disabling this
    // plugin must not brick the manifest that way.
    writeManifest(`
plugins:
  - id: demo
    name: demo-plugin
    config:
      note: "line1\\n&weird"
`);
    const before = fs.readFileSync(manifestPath, 'utf-8');

    const program = makeProgram();
    await expect(
      program.parseAsync(['node', 'octomux', 'plugins', 'disable', 'demo']),
    ).rejects.toThrow(/process\.exit/);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalled();
    const errText = String(errorSpy.mock.calls.at(-1)?.[0]);
    expect(errText).toContain('demo');

    // Nothing was written — the original manifest, still parseable, is intact.
    expect(fs.readFileSync(manifestPath, 'utf-8')).toBe(before);
    expect(fs.readdirSync(tmpDir)).toEqual(['octomux.yml']);
  });

  it('an interrupted write cannot leave a truncated manifest on disk', async () => {
    writeManifest(`
plugins:
  - id: demo
    name: demo-plugin
`);
    const before = fs.readFileSync(manifestPath, 'utf-8');

    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('simulated crash mid-write');
    });

    const program = makeProgram();
    await expect(
      program.parseAsync(['node', 'octomux', 'plugins', 'disable', 'demo']),
    ).rejects.toThrow(/process\.exit/);

    expect(exitSpy).toHaveBeenCalledWith(1);
    renameSpy.mockRestore();

    // The failed rename never touched the target file, and the temp file it
    // wrote first was cleaned up rather than left behind.
    expect(fs.readFileSync(manifestPath, 'utf-8')).toBe(before);
    expect(fs.readdirSync(tmpDir)).toEqual(['octomux.yml']);
  });

  describe('reload', () => {
    it('POSTs to the running server and reports success', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, loaded: { id: 'demo', order: 0 } }),
      });

      const program = makeProgram();
      await program.parseAsync(['node', 'octomux', 'plugins', 'reload', 'demo']);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:7777/api/plugins/demo/reload',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(logSpy).toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('--json mode prints the raw server response and exits 0 on success', async () => {
      const body = { ok: true, loaded: { id: 'demo', order: 0 } };
      mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => body });

      const program = makeProgram();
      await program.parseAsync(['node', 'octomux', '--json', 'plugins', 'reload', 'demo']);

      expect(lastJsonLog()).toEqual(body);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('a server-reported refusal (e.g. unloadable apiRouter plugin) exits 1 with the reason', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({
          ok: false,
          reason: 'plugin "demo" cannot be unloaded',
          unloadable: false,
        }),
      });

      const program = makeProgram();
      await expect(
        program.parseAsync(['node', 'octomux', 'plugins', 'reload', 'demo']),
      ).rejects.toThrow(/process\.exit/);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalled();
      expect(String(errorSpy.mock.calls.at(-1)?.[0])).toContain('cannot be unloaded');
    });

    it('cannot connect to the server: exits 1 with a start-it hint, never throws unhandled', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const program = makeProgram();
      await expect(
        program.parseAsync(['node', 'octomux', 'plugins', 'reload', 'demo']),
      ).rejects.toThrow(/process\.exit/);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(String(errorSpy.mock.calls.at(-1)?.[0])).toContain('octomux start');
    });
  });
});
