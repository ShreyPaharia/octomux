/**
 * src/lib/api/loopApi.ts
 *
 * Loop harness API surface: loop run feed, detail (with iterations), create,
 * and stop. Mirrors `server/routes/loops.ts`.
 */

import type { LoopRun, LoopIteration, LoopSpec } from '../../../server/types';
import { request } from './client';

export type { LoopRun, LoopIteration, LoopSpec };

export interface LoopRunDetail extends LoopRun {
  iterations: LoopIteration[];
}

export const loopApi = {
  listLoops: () => request<LoopRun[]>('/loops'),
  getLoop: (runId: string) => request<LoopRunDetail>(`/loops/${runId}`),
  createLoop: (taskId: string, spec: LoopSpec) =>
    request<LoopRun>('/loops', { method: 'POST', body: JSON.stringify({ taskId, spec }) }),
  stopLoop: (runId: string) => request<LoopRun>(`/loops/${runId}/stop`, { method: 'POST' }),
};
