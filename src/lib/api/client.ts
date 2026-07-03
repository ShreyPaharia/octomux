/**
 * src/lib/api/client.ts
 *
 * Web consumer of the shared @octomux/api-client request core. Per-domain
 * namespaces (`taskApi`, `reviewApi`, `configApi`) import `request` from here.
 */

import { createRequestCore } from '@octomux/api-client';

export const BASE = '/api';

export const { request } = createRequestCore({ baseUrl: BASE });
