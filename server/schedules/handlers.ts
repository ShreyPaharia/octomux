/**
 * kind → handler map for the generic cron poller (`server/poller/schedule-cron.ts`).
 * Each scheduled vertical registers its own handler as a side effect of its
 * `server/workflows/<kind>/register.ts` module (mirrors `registerWorkflow`).
 */
import type { ScheduleRow } from '../repositories/schedules.js';

export type ScheduleHandler = (row: ScheduleRow) => Promise<void>;

export const SCHEDULE_HANDLERS: Record<string, ScheduleHandler> = {};

export function registerScheduleHandler(kind: string, handler: ScheduleHandler): void {
  SCHEDULE_HANDLERS[kind] = handler;
}
