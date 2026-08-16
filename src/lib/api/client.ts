/**
 * src/lib/api/client.ts
 *
 * Web consumer of the shared @octomux/api-client request core. Per-domain
 * namespaces (`taskApi`, `reviewApi`, `configApi`) import `request` from here.
 */

import { createRequestCore } from '@octomux/api-client';

export const BASE = '/api';

// `clientClass: 'ui'` identifies the dashboard to the capability gate. Without
// it the server's fail-closed default treats every call as an agent and gates
// the UI's own requests.
export const { request } = createRequestCore({ baseUrl: BASE, clientClass: 'ui' });
