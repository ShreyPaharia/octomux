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
});
