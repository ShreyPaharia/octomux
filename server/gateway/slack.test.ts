import diagnosticsChannel from 'node:diagnostics_channel';
import { describe, it, expect, vi } from '../bun-test.js';
import { SocketModeClient } from '@slack/socket-mode';
import type { WebClient } from '@slack/web-api';
import { buildSlack, createSlackAdapter, ensureUndiciPing } from './slack.js';
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

describe('ensureUndiciPing', () => {
  /** A stand-in for bun's WebSocket: ping() plus DOM ping/pong listeners. */
  function fakeBunSocket() {
    const listeners: Record<string, ((e: { data: Buffer }) => void)[]> = {};
    return {
      ping: vi.fn(),
      addEventListener(type: string, cb: (e: { data: Buffer }) => void) {
        (listeners[type] ??= []).push(cb);
      },
      fire(type: string, data: Buffer) {
        for (const cb of listeners[type] ?? []) cb({ data });
      },
    };
  }

  /** socket-mode does its own require('undici') — same cached namespace object. */
  function undiciPing() {
    ensureUndiciPing();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const undici = require('undici') as {
      ping: (ws: unknown, data?: unknown) => void;
    };
    expect(typeof undici.ping).toBe('function');
    return undici.ping;
  }

  it("drives bun's WebSocket.ping with the payload socket-mode passes", () => {
    const ws = fakeBunSocket();
    const payload = Buffer.from('Ping from client (1)');
    undiciPing()(ws, payload);
    expect(ws.ping).toHaveBeenCalledWith(payload);
  });

  it('republishes bun ping/pong events onto the diagnostics channels', () => {
    const ws = fakeBunSocket();
    const seen: { channel: string; payload: Buffer }[] = [];
    const subs = (['ping', 'pong'] as const).map((name) => {
      const cb = (m: unknown) => {
        seen.push({ channel: name, payload: (m as { payload: Buffer }).payload });
      };
      diagnosticsChannel.channel(`undici:websocket:${name}`).subscribe(cb);
      return { name, cb };
    });

    undiciPing()(ws, Buffer.from('ping'));
    ws.fire('ping', Buffer.from('from-server'));
    ws.fire('pong', Buffer.from('Ping from client (1)'));

    for (const { name, cb } of subs) {
      diagnosticsChannel.channel(`undici:websocket:${name}`).unsubscribe(cb);
    }

    // Without this, socket-mode never sees a pong and disconnects every ~5s.
    expect(seen.map((s) => s.channel)).toEqual(['ping', 'pong']);
    expect(seen[1].payload.toString()).toBe('Ping from client (1)');
  });

  it('attaches the event bridge once, however many pings are sent', () => {
    const ws = fakeBunSocket();
    const ping = undiciPing();
    ping(ws, Buffer.from('a'));
    ping(ws, Buffer.from('b'));
    ping(ws, Buffer.from('c'));

    let pongs = 0;
    const cb = () => {
      pongs += 1;
    };
    diagnosticsChannel.channel('undici:websocket:pong').subscribe(cb);
    ws.fire('pong', Buffer.from('x'));
    diagnosticsChannel.channel('undici:websocket:pong').unsubscribe(cb);

    expect(ws.ping).toHaveBeenCalledTimes(3);
    expect(pongs).toBe(1);
  });
});
