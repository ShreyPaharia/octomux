/**
 * @octomux/capabilities
 *
 * Capability metadata and the transport projections that need only metadata.
 * Importable by the CLI and the browser: zod and plain types, no server.
 */

export type {
  CapabilityMeta,
  CallerClass,
  PolicyTier,
  HttpMethod,
  HttpProjection,
} from './types.js';

export { registerCapabilityCommands } from './cli.js';
export type { WriteLine } from './cli.js';

export * from './schemas.js';
export * from './capabilities/task.js';
export * from './capabilities/learning.js';
export * from './capabilities/run.js';
