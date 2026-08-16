/**
 * pino-roll ships no type declarations. Only the stream-factory form is declared
 * here — the shape `server/logger.ts` uses to avoid pino's worker-thread
 * transport, which `bun build --compile` can't resolve.
 */
declare module 'pino-roll' {
  interface RollOptions {
    file: string;
    frequency?: 'daily' | 'hourly' | number;
    size?: string;
    mkdir?: boolean;
    limit?: { count?: number };
  }

  export default function roll(options: RollOptions): Promise<NodeJS.WritableStream>;
}
