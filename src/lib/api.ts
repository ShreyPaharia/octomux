/**
 * src/lib/api.ts
 *
 * Thin compatibility shim. The API client now lives under `src/lib/api/`, split
 * into per-domain namespaces (`taskApi`, `reviewApi`, `configApi`) over a single
 * shared request core (`client.ts`), reassembled into the flat `api` object in
 * `src/lib/api/index.ts`. This module re-exports that surface so every existing
 * `@/lib/api` import — the flat `api` object and all namespace types — keeps
 * resolving unchanged.
 */

export * from './api/index';
