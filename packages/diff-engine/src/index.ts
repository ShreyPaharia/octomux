export type { DiffLogger, DiffRange, DiffTarget } from './types.js';
export { noopLogger } from './types.js';

export {
  BaseBranchMissingError,
  BaseUnavailableError,
  clearDiffBaseCache,
  resolveDiffBase,
  resolveRef,
  type ResolvedBase,
  type ResolveDiffBaseOptions,
} from './diff-base.js';

export {
  parseDiffRange,
  rangeIncludesWorkingTree,
  rangeNameStatusArgs,
  rangeNewRef,
  rangeNumstatArgs,
  rangeOldRef,
  WORKDIR,
  type RangeNewRef,
} from './diff-range.js';

export {
  blobAt,
  getDiffSummary,
  getFileDiff,
  hashObject,
  listChangedFiles,
  showFileAtSha,
  safeResolvePath,
  MAX_FILE_BYTES,
  MAX_IGNORED_FILES,
  IGNORED_DENY_PREFIXES,
  type DiffFileEntry,
  type DiffSummary,
  type FileDiff,
  type FileStatus,
  type GetDiffSummaryOptions,
} from './diff.js';

export { gitEnv } from './git-env.js';
export { targetWorkingDir } from './target-paths.js';
