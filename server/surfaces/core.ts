/**
 * server/surfaces/core.ts
 *
 * The four surfaces octomux ships compiled in today. All four are
 * READ-ONLY — none declares `prompt`.
 *
 * That's not an oversight: octomux's only human-question path today is the
 * card-based approval gate in `server/orchestrator/gate.ts`, which is
 * DB-backed and is not being rewritten by this ticket. Registering these
 * surfaces without `prompt` records the capability (a plugin surface CAN
 * declare one, and the host refuses cleanly on a surface that can't) — it is
 * not a claim that core prompting works today. Don't describe it as wired.
 */
import type { SurfaceDefinition } from '@octomux/plugin-api';
import { registerSurface } from './registry.js';
import { renderPanelText } from './text.js';

/**
 * The 8 renderer names the client renderer registry draws natively.
 * Source of truth: `src/workflows/renderers/index.tsx` (`RENDERERS` map's
 * keys). Kept in sync by hand — `@octomux/plugin-api` is types-only and
 * `server/` cannot import from `src/`.
 */
export const WEB_RENDERERS: readonly string[] = [
  'stat',
  'table',
  'timeline',
  'badge',
  'markdown',
  'json',
  'diff',
  'log',
];

export function registerCoreSurfaces(): void {
  registerSurface({
    kind: 'web',
    renderers: [...WEB_RENDERERS],
    // No `render`: the browser owns every renderer and reads the binding
    // table from GET /api/plugin-ui/contributions. No `prompt` either — see
    // the module doc above.
  } satisfies SurfaceDefinition);

  registerSurface({
    kind: 'cli',
    renderers: [...WEB_RENDERERS],
    render: renderPanelText,
  } satisfies SurfaceDefinition);

  registerSurface({
    kind: 'slack',
    // Slack mrkdwn has no native table, so `table` degrades to the fallback.
    renderers: ['stat', 'badge', 'markdown', 'timeline', 'log', 'diff', 'json'],
    fallback: 'json',
    render: renderPanelText,
  } satisfies SurfaceDefinition);

  registerSurface({
    kind: 'telegram',
    renderers: ['stat', 'badge', 'markdown', 'timeline', 'log', 'json'],
    fallback: 'json',
    render: renderPanelText,
  } satisfies SurfaceDefinition);
}
