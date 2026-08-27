import { execFile as execFileCb } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { tmuxWindowSubstrate } from '../agent-session/substrate-tmux-windowed.js';
import { sessionFor } from '../compute/index.js';
import { getSettings } from '../settings.js';
import type { Task, UserTerminal } from '../types.js';
import {
  updateTaskFields,
  insertUserTerminal as insertUserTerminalRepo,
  deleteUserTerminal,
  countUserTerminals,
} from '../repositories/index.js';

const execFile = promisify(execFileCb);

export interface UserTerminalResult {
  editor: 'nvim' | 'vscode' | 'cursor';
  windowIndex: number | null;
}

/**
 * On a remote (SSH) box, `code`/`cursor` on PATH are the editor's remote-CLI
 * shims: they forward "open folder" over the IPC socket named by
 * VSCODE_IPC_HOOK_CLI to an editor window already connected to this machine —
 * and exit 0 with an "only available in ... terminal" message when the var is
 * missing. The server is rarely started from an editor terminal, so discover a
 * live socket in the runtime dir instead. Returns undefined when the var is
 * already set or there are no sockets (desktop machine — plain launch works).
 */
async function editorIpcEnv(cmd: string): Promise<NodeJS.ProcessEnv | undefined> {
  if (process.env.VSCODE_IPC_HOOK_CLI) return undefined;
  let sockets: { p: string; mtime: number }[];
  try {
    const dir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`;
    const names = await fs.promises.readdir(dir);
    sockets = await Promise.all(
      names
        .filter((f) => f.startsWith('vscode-ipc-') && f.endsWith('.sock'))
        .map(async (f) => {
          const p = path.join(dir, f);
          return { p, mtime: (await fs.promises.stat(p)).mtimeMs };
        }),
    );
  } catch {
    return undefined;
  }
  // Newest first: the most recently connected editor window.
  sockets.sort((a, b) => b.mtime - a.mtime);
  for (const { p } of sockets.slice(0, 8)) {
    const env = { ...process.env, VSCODE_IPC_HOOK_CLI: p };
    try {
      await execFile(cmd, ['--version'], { env, timeout: 3000 });
      return env;
    } catch {
      // dead socket left by a closed window — try the next one
    }
  }
  return undefined;
}

export async function createUserTerminal(task: Task): Promise<UserTerminalResult> {
  const settings = await getSettings();
  const editor = settings.editor;

  if (editor === 'vscode' || editor === 'cursor') {
    // Opens on the operator's machine (desktop GUI, or a connected remote
    // window via editorIpcEnv), never on the task's compute — so this stays
    // plain execFile regardless of task.compute.
    const cmd = editor === 'vscode' ? 'code' : 'cursor';
    const name = editor === 'vscode' ? 'VS Code' : 'Cursor';
    const env = await editorIpcEnv(cmd);
    let res: { stdout?: string } | undefined;
    try {
      res = await execFile(cmd, [task.worktree!], env ? { env } : {});
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          `'${cmd}' CLI is not installed on the octomux server — install ${name} (or its CLI) there, or switch Editor in Settings`,
        );
      }
      throw err;
    }
    // The remote shim exits 0 even when it can't reach a window; surface that
    // instead of silently succeeding.
    if (/only available in/i.test(res?.stdout ?? '')) {
      throw new Error(
        `${cmd}: no ${name} window is connected to this machine — open ${name} over Remote-SSH to this host, then retry`,
      );
    }
    return { editor, windowIndex: null };
  }

  if (task.user_window_index !== null && task.user_window_index !== undefined) {
    return { editor, windowIndex: task.user_window_index };
  }

  const compute = await sessionFor(task);

  // Probe via the same interactive shell the window runs, so PATH matches.
  const shell = process.env.SHELL || '/bin/sh';
  try {
    await compute.exec([shell, '-ic', 'command -v nvim'], { timeoutMs: 15000 });
  } catch {
    throw new Error(
      'nvim is not installed on this machine — install neovim (brew install neovim / apt install neovim) or switch Editor in Settings',
    );
  }

  const windowIndex = await tmuxWindowSubstrate.launchWindow(compute, {
    session: task.tmux_session!,
    cwd: task.worktree!,
    fresh: false,
  });

  await compute.tmux(['send-keys', '-t', `${task.tmux_session}:${windowIndex}`, 'nvim .', 'Enter']);

  updateTaskFields(task.id, { user_window_index: windowIndex });

  return { editor: 'nvim', windowIndex };
}

export async function createShellTerminal(task: Task): Promise<UserTerminal> {
  const compute = await sessionFor(task);

  const windowIndex = await tmuxWindowSubstrate.launchWindow(compute, {
    session: task.tmux_session!,
    cwd: task.worktree!,
    fresh: false,
  });

  const count = countUserTerminals(task.id);
  const label = `Terminal ${count + 1}`;

  return insertUserTerminalRepo({ task_id: task.id, window_index: windowIndex, label });
}

export async function closeShellTerminal(task: Task, terminal: UserTerminal): Promise<void> {
  const compute = await sessionFor(task);
  await compute
    .tmux(['kill-window', '-t', `${task.tmux_session}:${terminal.window_index}`])
    .catch(() => {});
  deleteUserTerminal(terminal.id);
}
