import { describe, it, expect, beforeEach } from '../bun-test.js';
import {
  registerService,
  getService,
  serviceProvider,
  requireService,
  unmetRequirements,
  listPluginServices,
  unregisterPluginServices,
  resetServices,
  SERVICE_NAME_RE,
} from './services.js';

describe('plugins/services', () => {
  beforeEach(() => {
    resetServices();
  });

  it('resolves a service by name, with neither side naming the other', () => {
    const send = (text: string) => `slack: ${text}`;
    registerService('slack-bot', 'chat.send', send);
    requireService('changelog', 'chat.send');

    expect(unmetRequirements('changelog')).toEqual([]);
    expect((getService('chat.send') as typeof send)('hi')).toBe('slack: hi');
    expect(serviceProvider('chat.send')).toBe('slack-bot');
  });

  it('does not qualify the name — the whole point is a shared contract', () => {
    registerService('slack-bot', 'chat.send', {});
    expect(listPluginServices('slack-bot')).toEqual(['chat.send']);
    expect(getService('slack-bot:chat.send')).toBeUndefined();
  });

  it.each([
    ['chat.send', true],
    ['notify', true],
    ['a.b.c-d.e2', true],
    ['', false],
    ['Chat.Send', false],
    // A `:` would make a service name indistinguishable from a qualified
    // `<pluginId>:<kind>` id wherever the two get printed side by side.
    ['slack:chat.send', false],
    ['chat..send', false],
    ['.chat', false],
    ['chat.', false],
    ['-chat', false],
  ])('validates %o as %o', (name, ok) => {
    expect(SERVICE_NAME_RE.test(name)).toBe(ok);
    if (!ok) {
      expect(() => registerService('p', name, {})).toThrow(/service name/);
      expect(() => requireService('p', name)).toThrow(/service name/);
    }
  });

  it('rejects a nullish implementation', () => {
    expect(() => registerService('p', 'chat.send', undefined)).toThrow(/must not be nullish/);
    expect(() => registerService('p', 'chat.send', null)).toThrow(/must not be nullish/);
    expect(getService('chat.send')).toBeUndefined();
  });

  it('rejects the same plugin providing the same name twice', () => {
    registerService('slack-bot', 'chat.send', { v: 1 });
    expect(() => registerService('slack-bot', 'chat.send', { v: 2 })).toThrow(
      /already provided by this plugin/,
    );
    expect(getService('chat.send')).toEqual({ v: 1 });
  });

  describe('tie-break', () => {
    it('keeps the first registered provider live', () => {
      registerService('slack-bot', 'chat.send', { who: 'slack' });
      registerService('telegram-bot', 'chat.send', { who: 'telegram' });

      expect(getService('chat.send')).toEqual({ who: 'slack' });
      expect(serviceProvider('chat.send')).toBe('slack-bot');
      // Both still report providing it — the catalog is honest about who
      // implements the contract, not just about who won.
      expect(listPluginServices('slack-bot')).toEqual(['chat.send']);
      expect(listPluginServices('telegram-bot')).toEqual(['chat.send']);
    });

    it('promotes the queued provider when the live one unmounts', () => {
      registerService('slack-bot', 'chat.send', { who: 'slack' });
      registerService('telegram-bot', 'chat.send', { who: 'telegram' });

      expect(unregisterPluginServices('slack-bot')).toEqual(['chat.send']);
      expect(getService('chat.send')).toEqual({ who: 'telegram' });
      expect(unmetRequirements('anyone')).toEqual([]);
    });
  });

  describe('requirements', () => {
    it('reports unmet names sorted, and only unmet ones', () => {
      registerService('slack-bot', 'chat.send', {});
      requireService('changelog', 'ticket.create');
      requireService('changelog', 'chat.send');
      requireService('changelog', 'a.b');

      expect(unmetRequirements('changelog')).toEqual(['a.b', 'ticket.create']);
    });

    it('is idempotent and empty for a plugin that declared nothing', () => {
      requireService('changelog', 'chat.send');
      requireService('changelog', 'chat.send');
      expect(unmetRequirements('changelog')).toEqual(['chat.send']);
      expect(unmetRequirements('never-seen')).toEqual([]);
    });

    it('goes unmet again once the provider unmounts', () => {
      registerService('slack-bot', 'chat.send', {});
      requireService('changelog', 'chat.send');
      expect(unmetRequirements('changelog')).toEqual([]);

      unregisterPluginServices('slack-bot');
      expect(unmetRequirements('changelog')).toEqual(['chat.send']);
      expect(getService('chat.send')).toBeUndefined();
    });
  });

  describe('unregister', () => {
    it('drops provisions and requirements, and reports what it dropped', () => {
      registerService('bot', 'chat.send', {});
      registerService('bot', 'ticket.create', {});
      requireService('bot', 'metrics.push');

      expect(unregisterPluginServices('bot')).toEqual(['chat.send', 'ticket.create']);
      expect(listPluginServices('bot')).toEqual([]);
      expect(unmetRequirements('bot')).toEqual([]);
      expect(getService('chat.send')).toBeUndefined();
    });

    it('is a no-op for a plugin that provided nothing', () => {
      registerService('other', 'chat.send', {});
      expect(unregisterPluginServices('bot')).toEqual([]);
      expect(getService('chat.send')).toBeDefined();
    });
  });
});
