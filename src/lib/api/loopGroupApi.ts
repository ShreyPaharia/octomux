import { request } from './client';
import type { LoopRun } from './loopApi';

export interface LoopGroup {
  id: string;
  spec_json: string;
  n: number;
  repo_path: string;
  base_branch: string;
  judge_status: 'not_run' | 'running' | 'done' | 'error';
  winner_loop_run_id: string | null;
  judge_rationale: string | null;
  created_at: string;
  updated_at: string;
}

export interface LoopGroupDetail extends LoopGroup {
  loopRuns: LoopRun[];
}

export interface LoopSpecInput {
  prompt: string;
  verify: string;
  maxIterations: number;
  budget?: { tokens?: number; timeMs?: number };
  noProgress?: { afterIters: number };
}

export const loopGroupApi = {
  listLoopGroups: () => request<LoopGroup[]>('/loop-groups'),
  getLoopGroup: (id: string) => request<LoopGroupDetail>(`/loop-groups/${id}`),
  createLoopGroup: (data: {
    repoPath: string;
    baseBranch: string;
    spec: LoopSpecInput;
    n: number;
  }) => request<LoopGroupDetail>('/loop-groups', { method: 'POST', body: JSON.stringify(data) }),
  judgeLoopGroup: (id: string) =>
    request<LoopGroup>(`/loop-groups/${id}/judge`, { method: 'POST' }),
};
