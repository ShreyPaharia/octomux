/**
 * src/lib/api/secretsApi.ts
 *
 * Secrets API surface: metadata-only listing of the named secret store.
 * Mirrors `server/routes/secrets.ts`. There is deliberately no endpoint that
 * returns a secret's value — see SHR-277.
 */

import { request } from './client';

export interface SecretMeta {
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export const secretsApi = {
  listSecrets: () => request<{ secrets: SecretMeta[] }>('/secrets'),
};
