import type { ComputeFiles, ComputeSession } from './types.js';

/** Builds a `ComputeFiles` purely over `exec`, so a remote provider gets
 *  file ops in one line. */
export function execBackedFiles(exec: ComputeSession['exec']): ComputeFiles {
  return {
    async exists(p) {
      const { exitCode } = await exec(['test', '-e', p], { allowFailure: true });
      return exitCode === 0;
    },

    async mkdirp(p, opts) {
      await exec(['mkdir', '-p', p]);
      if (opts?.mode !== undefined) await exec(['chmod', opts.mode.toString(8), p]);
    },

    async read(p) {
      const { stdout, exitCode } = await exec(['cat', p], { allowFailure: true });
      return exitCode === 0 ? stdout : null;
    },

    async write(p, content, opts) {
      // Pass the path as $1 rather than interpolating it into the shell
      // string — `p` is caller-controlled and must never be shell-parsed.
      await exec(['sh', '-c', 'cat > "$1"', 'sh', p], { input: content });
      if (opts?.mode !== undefined) {
        await exec(['chmod', opts.mode.toString(8), p]);
      }
    },

    async chmod(p, mode) {
      await exec(['chmod', mode.toString(8), p]);
    },

    async copy(src, dst) {
      await exec(['cp', '-R', src, dst]);
    },

    async rm(p, opts) {
      await exec(['rm', ...(opts?.recursive ? ['-rf'] : ['-f']), p]);
    },
  };
}
