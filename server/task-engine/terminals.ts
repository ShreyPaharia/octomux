import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { execTmux } from '../tmux-bin.js';
import { getSettings } from '../settings.js';
import type { Task, UserTerminal } from '../types.js';
import {
  updateTaskFields,
  insertUserTerminal as insertUserTerminalRepo,
  deleteUserTerminal,
  countUserTerminals,
} from '../repositories/index.js';
import { getLastWindowIndex } from './sessions.js';

const execFile = promisify(execFileCb);

export interface UserTerminalResult {
  editor: 'nvim' | 'vscode' | 'cursor';
  windowIndex: number | null;
}

export async function createUserTerminal(task: Task): Promise<UserTerminalResult> {
  const settings = await getSettings();
  const editor = settings.editor;

  if (editor === 'vscode' || editor === 'cursor') {
    const cmd = editor === 'vscode' ? 'code' : 'cursor';
    await execFile(cmd, [task.worktree!]);
    return { editor, windowIndex: null };
  }

  if (task.user_window_index !== null && task.user_window_index !== undefined) {
    return { editor, windowIndex: task.user_window_index };
  }

  await execTmux(['new-window', '-t', task.tmux_session!, '-c', task.worktree!]);
  const windowIndex = await getLastWindowIndex(task.tmux_session!);

  await execTmux(['send-keys', '-t', `${task.tmux_session}:${windowIndex}`, 'nvim .', 'Enter']);

  updateTaskFields(task.id, { user_window_index: windowIndex });

  return { editor: 'nvim', windowIndex };
}

export async function createShellTerminal(task: Task): Promise<UserTerminal> {
  await execTmux(['new-window', '-t', task.tmux_session!, '-c', task.worktree!]);
  const windowIndex = await getLastWindowIndex(task.tmux_session!);

  const count = countUserTerminals(task.id);
  const label = `Terminal ${count + 1}`;

  return insertUserTerminalRepo({ task_id: task.id, window_index: windowIndex, label });
}

export async function closeShellTerminal(task: Task, terminal: UserTerminal): Promise<void> {
  await execTmux(['kill-window', '-t', `${task.tmux_session}:${terminal.window_index}`]).catch(
    () => {},
  );
  deleteUserTerminal(terminal.id);
}
