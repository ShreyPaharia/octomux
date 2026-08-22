/**
 * `parseCollectionQuery` — shared window-query parsing for a `ctx.records`
 * store read (`limit`/`offset`/`orderBy`/`order`). Named for its origin (the
 * pre-collapse durable keyed store, SHR-275); kept under this filename
 * because `server/routes/plugin-records.ts` and `server/routes/plugin-ui.ts`
 * both import it and the route path `/api/plugin-collections/:name/panels`
 * (`plugin-ui.ts`) is unchanged from that origin too.
 *
 * The `GET /api/plugin-collections/:name` raw-read route this file used to
 * serve is gone — `GET /api/plugin-records/:name` (`plugin-records.ts`) took
 * over that job under SHR-282.
 */
import type { Request } from 'express';
import type { QuerySpec } from '@octomux/plugin-api';

/**
 * Reads a `QuerySpec` out of a request's query string. Shared with the
 * rendered-panel route in `plugin-ui.ts`, which windows the same collections
 * for a server-rendered surface.
 *
 * `Number('abc')` is NaN and NaN never compares true, so an unparseable
 * limit/offset would silently misbehave rather than being rejected. Treat
 * anything non-finite as absent — same reasoning as `sinceSeq` in
 * `plugin-records.ts`.
 */
export function parseCollectionQuery(query: Request['query']): QuerySpec {
  const { limit, offset, orderBy, order } = query;
  const parsedLimit = typeof limit === 'string' && limit.length > 0 ? Number(limit) : undefined;
  const parsedOffset = typeof offset === 'string' && offset.length > 0 ? Number(offset) : undefined;
  return {
    limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    offset: Number.isFinite(parsedOffset) ? parsedOffset : undefined,
    orderBy: typeof orderBy === 'string' ? orderBy : undefined,
    order: order === 'asc' || order === 'desc' ? order : undefined,
  };
}
