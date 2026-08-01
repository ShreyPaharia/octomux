import { describe, it, expect, vi } from 'vitest';
import type { Transformer } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { buildTelegram, createTelegramAdapter } from './telegram.js';
import type { InboundMessage } from './adapter.js';

const TEST_BOT_INFO: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: 'test',
  username: 'testbot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

/** Stub transformer: never hits the network, records every call. */
function stubTransformer(calls: { method: string; payload: unknown }[]): Transformer {
  return (_prev, method, payload) => {
    calls.push({ method, payload });
    return Promise.resolve({ ok: true, result: {} }) as ReturnType<typeof _prev>;
  };
}

describe('telegram adapter', () => {
  it('has id "telegram"', () => {
    const adapter = createTelegramAdapter('fake-token', { botInfo: TEST_BOT_INFO });
    expect(adapter.id).toBe('telegram');
  });

  it('send() issues sendMessage with chat_id, text, parse_mode HTML', async () => {
    const calls: { method: string; payload: unknown }[] = [];
    const { adapter } = buildTelegram('fake-token', {
      botInfo: TEST_BOT_INFO,
      apiTransformer: stubTransformer(calls),
    });

    await adapter.send('123', '<b>hi</b>');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      method: 'sendMessage',
      payload: expect.objectContaining({
        chat_id: 123,
        text: '<b>hi</b>',
        parse_mode: 'HTML',
      }),
    });
  });

  it('sendTyping() issues sendChatAction with action "typing"', async () => {
    const calls: { method: string; payload: unknown }[] = [];
    const { adapter } = buildTelegram('fake-token', {
      botInfo: TEST_BOT_INFO,
      apiTransformer: stubTransformer(calls),
    });

    await adapter.sendTyping('123');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      method: 'sendChatAction',
      payload: expect.objectContaining({ chat_id: 123, action: 'typing' }),
    });
  });

  it('start() normalizes an inbound text update and calls onMessage', async () => {
    const calls: { method: string; payload: unknown }[] = [];
    const { adapter, bot } = buildTelegram('fake-token', {
      botInfo: TEST_BOT_INFO,
      // Intercepts bot.start()'s background getUpdates polling too, so no
      // real network call is ever made even though start() isn't awaited.
      apiTransformer: stubTransformer(calls),
    });

    const onMessage = vi.fn<(m: InboundMessage) => Promise<void>>().mockResolvedValue(undefined);
    await adapter.start(onMessage);

    await bot.handleUpdate({
      update_id: 42,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 555, type: 'private' },
        from: { id: 777, is_bot: false, first_name: 'u' },
        text: 'hello',
      },
    } as Parameters<typeof bot.handleUpdate>[0]);

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({
      channel: 'telegram',
      threadKey: '555',
      senderId: '777',
      externalId: '42',
      text: 'hello',
    });
  });
});
