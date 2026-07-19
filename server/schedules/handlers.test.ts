import { describe, it, expect } from 'vitest';
import { SCHEDULE_HANDLERS, registerScheduleHandler, listScheduleKinds } from './handlers.js';

describe('listScheduleKinds', () => {
  it('returns the kinds registered via registerScheduleHandler', () => {
    registerScheduleHandler('__test-kind__', async () => {});
    expect(listScheduleKinds()).toContain('__test-kind__');
    delete SCHEDULE_HANDLERS['__test-kind__'];
  });
});
