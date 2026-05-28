import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { childLogger } from './logger.js';
import * as diffMod from './diff.js';
import type { InlineCommentRow } from './inline-comments.js';

const execFile = promisify(execFileCb);
const logger = childLogger('inline-comments-outdated');

function splitLines(s: string): string[] {
  return s.split('\n');
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_')) env[k] = v;
  }
  return env;
}

async function gitShow(worktree: string, sha: string, relPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFile('git', ['-C', worktree, 'show', `${sha}:${relPath}`], {
      maxBuffer: 64 * 1024 * 1024,
      env: gitEnv(),
    });
    return stdout;
  } catch (err) {
    logger.debug(
      { worktree, sha, relPath, err: (err as Error).message },
      'git show failed; treating anchor as missing',
    );
    return null;
  }
}

/**
 * Compute the `outdated` flag per comment by comparing the anchored line text
 * (at `original_commit_sha`) with the current view (at `baseSha`).
 *
 * Dedupes git work: at most one `git show <sha>:<path>` per (sha, path) and
 * one `getFileDiff` per path.
 */
export async function computeOutdated(
  worktree: string,
  baseSha: string,
  comments: InlineCommentRow[],
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();

  // Dedupe anchored content fetches.
  const anchorKey = (sha: string, p: string) => `${sha}::${p}`;
  const anchorPromises = new Map<string, Promise<string | null>>();
  // Dedupe current-view fetches.
  const currentPromises = new Map<string, Promise<diffMod.FileDiff | null>>();

  for (const c of comments) {
    const ak = anchorKey(c.original_commit_sha, c.file_path);
    if (!anchorPromises.has(ak)) {
      anchorPromises.set(ak, gitShow(worktree, c.original_commit_sha, c.file_path));
    }
    if (!currentPromises.has(c.file_path)) {
      currentPromises.set(
        c.file_path,
        diffMod.getFileDiff({ worktree, base: baseSha, relPath: c.file_path }).catch((err) => {
          logger.debug(
            { worktree, baseSha, relPath: c.file_path, err: (err as Error).message },
            'getFileDiff failed; treating current view as missing',
          );
          return null;
        }),
      );
    }
  }

  for (const c of comments) {
    const anchored = await anchorPromises.get(anchorKey(c.original_commit_sha, c.file_path))!;
    const current = await currentPromises.get(c.file_path)!;

    if (anchored === null) {
      out.set(c.id, true);
      continue;
    }
    if (!current || current.binary || current.tooLarge || current.isDirectory) {
      out.set(c.id, true);
      continue;
    }

    const anchoredLines = splitLines(anchored);
    const currentSource = c.side === 'new' ? current.newContent : current.oldContent;
    const currentLines = splitLines(currentSource);

    const idx = c.line - 1;
    if (idx < 0 || idx >= anchoredLines.length || idx >= currentLines.length) {
      out.set(c.id, true);
      continue;
    }

    out.set(c.id, anchoredLines[idx] !== currentLines[idx]);
  }

  return out;
}

export { splitLines };

export interface AnchorCheck {
  worktree: string;
  oldSha: string;
  newSha: string;
  file: string;
  line: number;
  side: 'old' | 'new';
}

/**
 * Returns true when the line at `line` in `file` differs between `oldSha` and `newSha`,
 * or when the file is missing at either ref / the line index is out of range.
 */
export async function isAnchorOutdated(input: AnchorCheck): Promise<boolean> {
  const oldContent = await gitShow(input.worktree, input.oldSha, input.file);
  const newContent = await gitShow(input.worktree, input.newSha, input.file);
  if (oldContent === null || newContent === null) return true;
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  const idx = input.line - 1;
  if (idx < 0 || idx >= newLines.length || idx >= oldLines.length) return true;
  return oldLines[idx] !== newLines[idx];
}
