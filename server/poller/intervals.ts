/** Poll cadences — 0 in test env so setInterval is skipped (tests call tick fns directly). */
export const QUIESCENCE_INTERVAL = process.env.NODE_ENV === 'test' ? 0 : 5000;
export const QUIESCENCE_DEBOUNCE_MS = 90000; // 90s: must exceed observed subagent re-wake gaps (30–75s)
export const STATUS_INTERVAL = process.env.NODE_ENV === 'test' ? 0 : 5000;
export const PR_INTERVAL = process.env.NODE_ENV === 'test' ? 0 : 60000;
export const MERGED_PR_INTERVAL = process.env.NODE_ENV === 'test' ? 0 : 60000;
export const DELETE_INTERVAL = process.env.NODE_ENV === 'test' ? 0 : 60 * 60 * 1000; // 1h
export const HANDOFF_INTERVAL = process.env.NODE_ENV === 'test' ? 0 : 5000;
/** Sweep expired orchestrator approval cards once a minute (SHR-164). */
export const APPROVAL_INTERVAL = process.env.NODE_ENV === 'test' ? 0 : 60000;
/** Generic cron trigger: check `schedules` rows against the current UTC minute once a minute. */
export const SCHEDULE_INTERVAL = process.env.NODE_ENV === 'test' ? 0 : 60000;
/** Feed prod-log-triage PR review comments into the loop playbook. */
export const TRIAGE_PR_COMMENTS_INTERVAL = process.env.NODE_ENV === 'test' ? 0 : 60000;
/** Nudge auto-review agents whose turn died mid-stream (no Stop hook fires). */
export const REVIEW_STALL_INTERVAL = process.env.NODE_ENV === 'test' ? 0 : 60000;
// 15 min: must exceed the longest observed tool-free synthesis turn (~13 min);
// the pane in-flight check is the real guard, this just bounds sweep frequency.
export const REVIEW_STALL_AFTER_MS = 15 * 60 * 1000;
export const REVIEW_STALL_MAX_NUDGES = 3;
