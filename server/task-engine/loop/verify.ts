import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

const execFile = promisify(execFileCb);

export interface VerifyResult {
  passed: boolean;
  output: string;
}

/** Run the loop's verify shell command in `cwd`; exit 0 = pass. */
export async function runVerify(cwd: string, cmd: string): Promise<VerifyResult> {
  try {
    const { stdout, stderr } = await execFile('sh', ['-c', cmd], { cwd });
    return { passed: true, output: stdout + stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    const output = [e.stdout, e.stderr].filter(Boolean).join('') || e.message;
    return { passed: false, output };
  }
}
