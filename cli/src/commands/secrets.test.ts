import { describe, it, expect, beforeEach, afterEach, vi } from '../../../server/bun-test.js';
import { Command } from 'commander';
import { registerSecrets } from './secrets.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeProgram(): Command {
  const program = new Command();
  program
    .option('-s, --server-url <url>', 'server URL', 'http://localhost:7777')
    .option('--json', 'output as JSON');
  program.exitOverride();
  registerSecrets(program);
  return program;
}

describe('octomux secrets', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockFetch.mockReset();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function lastJsonLog(): unknown {
    const call = logSpy.mock.calls.at(-1);
    return JSON.parse((call as unknown[])[0] as string);
  }

  describe('list', () => {
    it('GETs /api/secrets and prints a table with no value column', async () => {
      mockFetch.mockResolvedValue({
        status: 200,
        json: async () => ({
          secrets: [{ name: 'FOO', description: 'a token', created_at: 'x', updated_at: 'y' }],
        }),
      });

      const program = makeProgram();
      await program.parseAsync(['node', 'octomux', 'secrets', 'list']);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:7777/api/secrets',
        expect.objectContaining({}),
      );
      expect(exitSpy).not.toHaveBeenCalled();
      const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).not.toContain('value');
    });

    it('--json prints the raw secrets array', async () => {
      const secrets = [{ name: 'FOO', description: null, created_at: 'x', updated_at: 'y' }];
      mockFetch.mockResolvedValue({ status: 200, json: async () => ({ secrets }) });

      const program = makeProgram();
      await program.parseAsync(['node', 'octomux', '--json', 'secrets', 'list']);

      expect(lastJsonLog()).toEqual(secrets);
    });
  });

  describe('set', () => {
    it('requires exactly one of --value or --stdin', async () => {
      const program = makeProgram();
      await expect(
        program.parseAsync(['node', 'octomux', 'secrets', 'set', 'FOO']),
      ).rejects.toThrow(/process\.exit/);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects both --value and --stdin', async () => {
      const program = makeProgram();
      await expect(
        program.parseAsync(['node', 'octomux', 'secrets', 'set', 'FOO', '--value', 'x', '--stdin']),
      ).rejects.toThrow(/process\.exit/);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('PUTs the value via --value and never logs it', async () => {
      mockFetch.mockResolvedValue({
        status: 200,
        json: async () => ({
          name: 'FOO',
          description: null,
          created_at: 'x',
          updated_at: 'y',
        }),
      });

      const program = makeProgram();
      await program.parseAsync([
        'node',
        'octomux',
        'secrets',
        'set',
        'FOO',
        '--value',
        'super-secret-abc',
      ]);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:7777/api/secrets/FOO',
        expect.objectContaining({ method: 'PUT' }),
      );
      const sentBody = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body) as {
        value: string;
      };
      expect(sentBody.value).toBe('super-secret-abc');

      const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).not.toContain('super-secret-abc');
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('a server-side rejection (e.g. bad name) exits 1 with the reason', async () => {
      mockFetch.mockResolvedValue({
        status: 400,
        json: async () => ({ error: 'invalid secret name: bad name' }),
      });

      const program = makeProgram();
      await expect(
        program.parseAsync(['node', 'octomux', 'secrets', 'set', 'FOO', '--value', 'x']),
      ).rejects.toThrow(/process\.exit/);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(String(errorSpy.mock.calls.at(-1)?.[0])).toContain('invalid secret name');
    });
  });

  describe('rm', () => {
    it('DELETEs and reports success', async () => {
      mockFetch.mockResolvedValue({ status: 204, json: async () => ({}) });

      const program = makeProgram();
      await program.parseAsync(['node', 'octomux', 'secrets', 'rm', 'FOO']);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:7777/api/secrets/FOO',
        expect.objectContaining({ method: 'DELETE' }),
      );
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('404 exits 1 with a not-found message', async () => {
      mockFetch.mockResolvedValue({ status: 404, json: async () => ({}) });

      const program = makeProgram();
      await expect(
        program.parseAsync(['node', 'octomux', 'secrets', 'rm', 'NOPE']),
      ).rejects.toThrow(/process\.exit/);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(String(errorSpy.mock.calls.at(-1)?.[0])).toContain('No secret named');
    });
  });
});
