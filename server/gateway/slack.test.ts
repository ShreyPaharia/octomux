import { describe, it, expect, vi } from 'vitest';
import { SocketModeClient } from '@slack/socket-mode';
import type { WebClient } from '@slack/web-api';
import { buildSlack, createSlackAdapter } from './slack.js';
import type { InboundMessage } from './adapter.js';

/** Fake WebClient: records postMessage calls, never touches the network. */
function fakeWebClient() {
  return {
    chat: { postMessage: vi.fn().mockResolvedValue({ ok: true }) },
  } as unknown as WebClient;
}

/**
 * A real SocketModeClient — constructing it does not connect, only
 * `.start()` does — with `.start()` stubbed out so tests never open a
 * websocket. Tests drive inbound events via `socket.emit('message', ...)`.
 */
function fakeSocket() {
  const socket = new SocketModeClient({ appToken: 'xapp-test' });
  socket.start = vi.fn().mockResolvedValue({});
  return socket;
}

/** EventEmitter listeners aren't awaited by `emit()` — flush pending microtasks. */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('slack adapter', () => {
  it('has id "slack"', () => {
    const adapter = createSlackAdapter('xoxb-test', 'xapp-test', {
      client: fakeWebClient(),
      socket: fakeSocket(),
    });
    expect(adapter.id).toBe('slack');
  });

  it('send() calls chat.postMessage with channel and text', async () => {
    const client = fakeWebClient();
    const { adapter } = buildSlack('xoxb-test', 'xapp-test', { client, socket: fakeSocket() });

    await adapter.send('C123', 'hello');

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(client.chat.postMessage).toHaveBeenCalledWith({ channel: 'C123', text: 'hello' });
  });

  it('start() normalizes an inbound message event and calls onMessage', async () => {
    const socket = fakeSocket();
    const { adapter } = buildSlack('xoxb-test', 'xapp-test', { client: fakeWebClient(), socket });

    const onMessage = vi.fn<(m: InboundMessage) => Promise<void>>().mockResolvedValue(undefined);
    await adapter.start(onMessage);

    const ack = vi.fn().mockResolvedValue(undefined);
    await socket.emit('message', {
      ack,
      envelope_id: 'env-1',
      body: { event_id: 'Ev123' },
      event: {
        type: 'message',
        channel: 'C555',
        user: 'U777',
        text: 'hello',
        ts: '1234.5678',
      },
    });
    await flush();

    expect(ack).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({
      channel: 'slack',
      threadKey: 'C555',
      senderId: 'U777',
      externalId: 'Ev123',
      text: 'hello',
    });
  });

  it('ignores messages with bot_id (echo-loop guard)', async () => {
    const socket = fakeSocket();
    const { adapter } = buildSlack('xoxb-test', 'xapp-test', { client: fakeWebClient(), socket });

    const onMessage = vi.fn<(m: InboundMessage) => Promise<void>>().mockResolvedValue(undefined);
    await adapter.start(onMessage);

    const ack = vi.fn().mockResolvedValue(undefined);
    await socket.emit('message', {
      ack,
      envelope_id: 'env-2',
      body: { event_id: 'Ev124' },
      event: {
        type: 'message',
        channel: 'C555',
        user: 'U777',
        text: 'hello',
        ts: '1234.5679',
        bot_id: 'B999',
      },
    });
    await flush();

    expect(ack).toHaveBeenCalledTimes(1);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('ignores messages with a subtype (edits/joins/deletions)', async () => {
    const socket = fakeSocket();
    const { adapter } = buildSlack('xoxb-test', 'xapp-test', { client: fakeWebClient(), socket });

    const onMessage = vi.fn<(m: InboundMessage) => Promise<void>>().mockResolvedValue(undefined);
    await adapter.start(onMessage);

    const ack = vi.fn().mockResolvedValue(undefined);
    await socket.emit('message', {
      ack,
      envelope_id: 'env-3',
      body: { event_id: 'Ev125' },
      event: {
        type: 'message',
        channel: 'C555',
        user: 'U777',
        text: 'edited hello',
        ts: '1234.5680',
        subtype: 'message_changed',
      },
    });
    await flush();

    expect(ack).toHaveBeenCalledTimes(1);
    expect(onMessage).not.toHaveBeenCalled();
  });
});
