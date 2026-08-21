import { describe, it, expect, beforeEach, afterEach, vi } from '../../../server/bun-test.js';
import { Command } from 'commander';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerDoctor } from './doctor.js';
import type { LoadReport } from '@octomux/plugin-api';

function makeProgram(): Command {
  const program = new Command();
  program
    .option('-s, --server-url <url>', 'server URL', 'http://localhost:7777')
    .option('--json', 'output as JSON');
  program.exitOverride();
  registerDoctor(program);
  return program;
}

describe('octomux doctor', () => {
  let tmpDir: string;
  let reportPath: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-doctor-cli-test-'));
    reportPath = path.join(tmpDir, 'plugin-load-report.json');
    vi.stubEnv('OCTOMUX_DATA_DIR', tmpDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeReport(report: LoadReport): void {
    fs.writeFileSync(reportPath, JSON.stringify(report), 'utf-8');
  }

  it('degrades gracefully when no report has been persisted yet', async () => {
    const program = makeProgram();
    await program.parseAsync(['node', 'octomux', '--json', 'doctor']);

    const logged = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string);
    expect(logged).toEqual({ reportPath, report: null });
  });

  it('renders a loaded plugin and a failed one from the persisted report (non-TTY mode text)', async () => {
    writeReport({
      loaded: [
        {
          id: 'demo',
          name: 'demo-plugin',
          version: '1.0.0',
          resolvedPath: '/x',
          order: 0,
          applyMs: 3.2,
        },
      ],
      failed: [{ id: 'boom', name: 'boom-plugin', error: 'kaboom', phase: 'apply' }],
      manifestPath: '/fake/octomux.yml',
      safeMode: false,
    });

    // isJsonMode() defaults to JSON whenever stdout isn't a TTY (true under
    // bun test), so force the human-readable branch explicitly the same way
    // a real interactive terminal session would.
    vi.spyOn(process.stdout, 'isTTY', 'get').mockReturnValue(true);

    const program = makeProgram();
    await program.parseAsync(['node', 'octomux', 'doctor']);

    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('/fake/octomux.yml');
    expect(output).toContain('demo');
    expect(output).toContain('demo-plugin@1.0.0');
    expect(output).toContain('boom');
    expect(output).toContain('kaboom');
    expect(output).toContain('apply');
  });

  it('prints a provides summary for a plugin with routes and a workflow', async () => {
    writeReport({
      loaded: [
        {
          id: 'coverage-bot',
          name: 'coverage-bot-plugin',
          version: '1.0.0',
          resolvedPath: '/x',
          order: 0,
          applyMs: 1.1,
          provides: [
            'route:GET /coverage/:task',
            'route:POST /coverage/:task',
            'workflow:coverage-bot:changelog',
          ],
        },
        {
          id: 'no-provides',
          name: 'no-provides-plugin',
          version: '1.0.0',
          resolvedPath: '/y',
          order: 1,
          applyMs: 0.5,
        },
      ],
      failed: [],
      manifestPath: '/fake/octomux.yml',
      safeMode: false,
    });

    vi.spyOn(process.stdout, 'isTTY', 'get').mockReturnValue(true);

    const program = makeProgram();
    await program.parseAsync(['node', 'octomux', 'doctor']);

    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('coverage-bot (coverage-bot-plugin@1.0.0)');
    expect(output).toContain('1 workflow, 2 routes');
    // An older persisted report with no `provides` at all gets no summary
    // suffix — must not read as "0 of everything".
    expect(output).toContain('no-provides (no-provides-plugin@1.0.0) — 0.5ms\n');
  });

  it('reports JSON mode with the raw persisted report', async () => {
    const report: LoadReport = {
      loaded: [],
      failed: [],
      manifestPath: '/fake/octomux.yml',
      safeMode: true,
    };
    writeReport(report);

    const program = makeProgram();
    await program.parseAsync(['node', 'octomux', '--json', 'doctor']);

    const logged = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string);
    expect(logged).toEqual({ reportPath, report });
  });

  it('leads with the manifest error instead of a clean bill of health', async () => {
    writeReport({
      loaded: [],
      failed: [],
      manifestPath: '/fake/octomux.yml',
      safeMode: false,
      manifestError: 'invalid plugin manifest: YAML anchors/aliases are not allowed',
      loadedAt: '2026-08-17T00:00:00.000Z',
    });

    vi.spyOn(process.stdout, 'isTTY', 'get').mockReturnValue(true);

    const program = makeProgram();
    await program.parseAsync(['node', 'octomux', 'doctor']);

    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('Manifest failed to parse');
    expect(output).toContain('YAML anchors/aliases are not allowed');
    expect(output).toContain('Loaded (0)');
    expect(output).toContain('2026-08-17T00:00:00.000Z');
    // The manifest-error headline must be the first thing printed, not a
    // footnote after Loaded/Failed.
    expect(output.indexOf('Manifest failed to parse')).toBeLessThan(output.indexOf('Loaded (0)'));
  });

  it('distinguishes a corrupt report file from no report at all', async () => {
    fs.writeFileSync(reportPath, '{ not valid json', 'utf-8');

    const program = makeProgram();
    await program.parseAsync(['node', 'octomux', '--json', 'doctor']);

    const logged = JSON.parse(logSpy.mock.calls.at(-1)?.[0] as string) as {
      reportPath: string;
      report: null;
      corrupt: boolean;
      error: string;
    };
    expect(logged.report).toBeNull();
    expect(logged.corrupt).toBe(true);
    expect(logged.error).toBeTruthy();
  });

  it('strips control characters from a plugin-controlled error before printing', async () => {
    writeReport({
      loaded: [],
      failed: [
        {
          id: 'boom',
          name: 'boom-plugin',
          // ESC + a cursor-repaint escape sequence, e.g. an attempt to hide
          // the rest of the diagnostic output.
          error: 'kaboom\x1b[2K\x1b[1A fake clean output',
          phase: 'apply',
        },
      ],
      manifestPath: '/fake/octomux.yml',
      safeMode: false,
    });

    vi.spyOn(process.stdout, 'isTTY', 'get').mockReturnValue(true);

    const program = makeProgram();
    await program.parseAsync(['node', 'octomux', 'doctor']);

    const output = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('kaboom');
    expect(output).toContain('fake clean output');
    // eslint-disable-next-line no-control-regex
    expect(output).not.toMatch(/\x1b\[/);
  });
});
