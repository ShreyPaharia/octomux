/** Poll cadences — 0 in test env so setInterval is skipped (tests call tick fns directly). */
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
