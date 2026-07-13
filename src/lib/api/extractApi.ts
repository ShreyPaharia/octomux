/**
 * src/lib/api/extractApi.ts
 *
 * PR-extract workflow API surface: feed of extracted-PR rows + detail.
 * Mirrors `server/routes/pr-extracts.ts`.
 */

import type { PrExtract } from '../../../server/types';
import { request } from './client';

export type { PrExtract };

export const extractApi = {
  listExtracts: () => request<PrExtract[]>('/pr-extracts'),
  getExtract: (id: string) => request<PrExtract>(`/pr-extracts/${id}`),
};
