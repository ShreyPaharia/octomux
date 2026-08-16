/**
 * Benchmark task creation: runs the real `startTask` (worktree + preflight +
 * skills/agents/hooks sync + tmux launch) N times against a real repo and
 * prints a per-stage breakdown.
 *
 * Usage:
 *   bun run bench:task-create                        # 3 runs against cwd
 *   bun run bench:task-create -- --repo ~/x --runs 5
 *   bun run bench:task-create -- --keep              # don't delete the tasks
 *
 * Stage timings come from the `stage_timing: true` log lines emitted by
 * startTask, captured here via a pino stream.
 */
import { Writable } from 'stream';
import Database from '../server/sqlite.js';
import { pino } from 'pino';
import { nanoid } from 'nanoid';
import { initDb, setDb } from '../server/db.js';
import { setLogger } from '../server/logger.js';
import { insertTask, insertWorktree, getTask } from '../server/repositories/index.js';
import { startTask, deleteTask } from '../server/task-engine/index.js';
import { ensureTmuxRuntimeDir } from '../server/tmux-bin.js';
import type { Task } from '../server/types.js';

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const repo = flag('repo', process.cwd())!;
const runs = Number(flag('runs', '3'));
const keep = args.includes('--keep');
const verbose = args.includes('--verbose');

// ─── Capture stage timings out of the log stream ─────────────────────────────
const timings: Record<string, number>[] = [];
let current: Record<string, number> = {};

const sink = new Writable({
  write(chunk, _enc, cb) {
    for (const line of String(chunk).split('\n').filter(Boolean)) {
      try {
        const rec = JSON.parse(line);
        if (rec.stage_timing) current[rec.stage] = rec.duration_ms;
        if (verbose) console.error(`  · ${rec.module}: ${rec.msg}`);
      } catch {
        // non-JSON line
      }
    }
    cb();
  },
});
setLogger(pino({ level: 'trace' }, sink));

const db = new Database(':memory:');
initDb(db);
setDb(db);
ensureTmuxRuntimeDir(); // normally done at server boot

function seedTask(i: number): Task {
  const id = nanoid(12);
  const worktreeId = nanoid(12);
  insertWorktree({
    id: worktreeId,
    path: '',
    repo_path: repo,
    branch: null,
    base_branch: null,
    mode: 'new',
    status: 'available',
  });
  insertTask({
    id,
    title: `bench ${i} ${id}`,
    description: 'task-creation benchmark',
    runtime_state: 'setting_up',
    workflow_status: 'planned',
    initial_prompt: null,
    worktree_id: worktreeId,
    agent: null,
    harness_id: 'claude-code',
    model: null,
    notify_task_id: null,
  });
  return getTask(id) as Task;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

console.log(`benchmarking task creation — repo=${repo} runs=${runs}\n`);

const totals: number[] = [];
for (let i = 0; i < runs; i++) {
  current = {};
  const task = seedTask(i);
  const t0 = performance.now();
  await startTask(task);
  const total = Math.round(performance.now() - t0);
  totals.push(total);
  timings.push(current);

  const fresh = getTask(task.id) as Task;
  console.log(
    `run ${i + 1}: ${total}ms  state=${fresh.runtime_state}${fresh.error ? ` err=${fresh.error}` : ''}`,
  );
  if (!keep) await deleteTask(fresh);
}

// ─── Report ──────────────────────────────────────────────────────────────────
const stages = [...new Set(timings.flatMap((t) => Object.keys(t)))];
const totalMedian = median(totals);

console.log('\nstage                median    % of total');
console.log('─'.repeat(44));
for (const stage of stages) {
  const vals = timings.map((t) => t[stage] ?? 0);
  const m = median(vals);
  const pct = totalMedian ? ((m / totalMedian) * 100).toFixed(1) : '0';
  console.log(`${stage.padEnd(20)} ${String(Math.round(m)).padStart(6)}ms  ${pct.padStart(6)}%`);
}
console.log('─'.repeat(44));
console.log(`${'TOTAL'.padEnd(20)} ${String(totalMedian).padStart(6)}ms`);
console.log(`\nall runs: ${totals.join(', ')} ms`);
process.exit(0);
