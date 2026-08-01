import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '../test-helpers.js';
import { createGateway, type GatewayConductor } from './gateway.js';
import type { ChannelAdapter, InboundMessage } from './adapter.js';
import type { ChatEvent } from '../orchestrator/transcript.js';
import {
  createConversation,
  updateConversation,
  getPrimaryAgentConversation,
} from '../repositories/orchestrator.js';
import { createAgent, getAgent } from '../repositories/agents.js';
import { pushToConversation } from '../orchestrator/stream.js';

/** A fake adapter that records outbound sends / typing indicators. */
function fakeAdapter() {
  const sent: Array<{ threadKey: string; text: string }> = [];
  const typing: string[] = [];
  const adapter: ChannelAdapter = {
    id: 'telegram',
    start: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(async (threadKey: string, text: string) => {
      sent.push({ threadKey, text });
    }),
    sendTyping: vi.fn(async (threadKey: string) => {
      typing.push(threadKey);
    }),
  };
  return { adapter, sent, typing };
}

/**
 * A fake conductor: no tmux, no real tail. `startConversation` stamps a
 * transcript path (as the real one does), `registerConsumer` captures the
 * consumer so the test can feed it ChatEvents, and sendTurn/interruptTurn record.
 */
function fakeConductor() {
  const sendTurn = vi.fn(async (_convId: string, _text: string) => undefined);
  const interruptTurn = vi.fn(async (_convId: string) => undefined);
  const consumers = new Map<string, (e: ChatEvent) => void>();

  const conductor: GatewayConductor = {
    startConversation: vi.fn(
      async (convId: string, _cwd: string, _opts?: { systemPrompt?: string }) => {
        updateConversation(convId, { transcript_path: `/fake/${convId}.jsonl` });
      },
    ),
    sendTurn,
    interruptTurn,
    registerConsumer: vi.fn((convId, _path, consumer) => {
      consumers.set(convId, consumer);
      return () => consumers.delete(convId);
    }),
  };
  /** Feed a ChatEvent to the consumer registered for a conversation. */
  const emit = (convId: string, e: ChatEvent) => consumers.get(convId)!(e);
  return { conductor, sendTurn, interruptTurn, emit };
}

const ALLOWED = '555';
function inbound(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: 'telegram',
    threadKey: 'chat-1',
    senderId: ALLOWED,
    externalId: 'upd-1',
    text: 'what tasks are running?',
    ...over,
  };
}

describe('gateway glue', () => {
  beforeEach(() => {
    createTestDb();
    process.env.OCTOMUX_GATEWAY_TELEGRAM_ALLOW = ALLOWED;
  });

  it('drops a message from a non-allowlisted sender (never dispatches)', async () => {
    const { adapter } = fakeAdapter();
    const { conductor, sendTurn } = fakeConductor();
    const gw = createGateway(adapter, conductor);

    await gw.handleInbound(inbound({ senderId: '999' }));

    expect(sendTurn).not.toHaveBeenCalled();
  });

  it('dedupes a redelivered external id (dispatches once)', async () => {
    const { adapter } = fakeAdapter();
    const { conductor, sendTurn } = fakeConductor();
    const gw = createGateway(adapter, conductor);

    await gw.handleInbound(inbound({ externalId: 'dup' }));
    await gw.handleInbound(inbound({ externalId: 'dup', text: 'second copy' }));

    expect(sendTurn).toHaveBeenCalledTimes(1);
  });

  it('creates a conversation, sends the turn, and flushes the redacted reply on turn-done', async () => {
    const { adapter, sent } = fakeAdapter();
    const { conductor, sendTurn, emit } = fakeConductor();
    const gw = createGateway(adapter, conductor);

    await gw.handleInbound(inbound());
    expect(sendTurn).toHaveBeenCalledTimes(1);
    const convId = sendTurn.mock.calls[0]![0] as string;

    // Conductor replies over two assistant lines, one carrying a secret, then the
    // stop_hook_summary boundary.
    emit(convId, { type: 'assistant', text: 'Two tasks running.', uuid: 'a1', timestamp: 't' });
    emit(convId, {
      type: 'assistant',
      text: 'token is ghp_ABCDEFGH12345678',
      uuid: 'a2',
      timestamp: 't',
    });
    emit(convId, { type: 'system', subtype: 'stop_hook_summary', uuid: 's1', timestamp: 't' });

    // Outbound delivery is an async queue — let it flush.
    await new Promise((r) => setTimeout(r, 0));

    expect(sent).toHaveLength(1);
    expect(sent[0]!.threadKey).toBe('chat-1');
    expect(sent[0]!.text).toContain('Two tasks running.');
    // Secret scrubbed by redactSecrets before it leaves the process.
    expect(sent[0]!.text).not.toContain('ghp_ABCDEFGH12345678');
  });

  it('reuses the same conversation for a second message on the same thread', async () => {
    const { adapter } = fakeAdapter();
    const { conductor, sendTurn, emit } = fakeConductor();
    const gw = createGateway(adapter, conductor);

    await gw.handleInbound(inbound({ externalId: 'm1' }));
    const convId = sendTurn.mock.calls[0]![0] as string;
    emit(convId, { type: 'system', subtype: 'stop_hook_summary', uuid: 's1', timestamp: 't' });

    await gw.handleInbound(inbound({ externalId: 'm2', text: 'follow up' }));

    expect(sendTurn).toHaveBeenCalledTimes(2);
    expect(sendTurn.mock.calls[1]![0]).toBe(convId); // same conversation
    expect(conductor.startConversation).toHaveBeenCalledTimes(1); // created only once
  });

  it('interrupts a running turn when a new message arrives mid-turn', async () => {
    const { adapter } = fakeAdapter();
    const { conductor, sendTurn, interruptTurn } = fakeConductor();
    const gw = createGateway(adapter, conductor);

    // First message → turn in flight (no stop_hook_summary emitted yet).
    await gw.handleInbound(inbound({ externalId: 'm1' }));
    const convId = sendTurn.mock.calls[0]![0] as string;

    // Second message arrives before the first turn finished → interrupt-and-merge.
    await gw.handleInbound(inbound({ externalId: 'm2', text: 'actually, stop' }));

    expect(interruptTurn).toHaveBeenCalledWith(convId);
    expect(sendTurn).toHaveBeenCalledTimes(2);
  });

  it("routes an inbound message on a channel bound to an agent to that agent's persistent session", async () => {
    const agentId = createAgent({
      name: 'Ops Agent',
      system_prompt: 'You watch prod and page on-call.',
      channel: 'telegram',
      channel_config: JSON.stringify({ threadKey: 'chat-1' }),
    });

    const { adapter } = fakeAdapter();
    const { conductor, sendTurn } = fakeConductor();
    const gw = createGateway(adapter, conductor);

    await gw.handleInbound(inbound());

    expect(sendTurn).toHaveBeenCalledTimes(1);
    const convId = sendTurn.mock.calls[0]![0] as string;

    // The agent now has exactly one persistent conversation, and it's the one dispatched to.
    const agentConv = getPrimaryAgentConversation(agentId);
    expect(agentConv?.id).toBe(convId);

    // The session was started with the agent's system prompt.
    expect(conductor.startConversation).toHaveBeenCalledWith(
      convId,
      expect.any(String),
      expect.objectContaining({ systemPrompt: 'You watch prod and page on-call.' }),
    );
  });

  it('reuses the same agent conversation across messages and does not restart the session', async () => {
    createAgent({
      name: 'Ops Agent',
      system_prompt: 'You watch prod.',
      channel: 'telegram',
      channel_config: JSON.stringify({ threadKey: 'chat-1' }),
    });

    const { adapter } = fakeAdapter();
    const { conductor, sendTurn, emit } = fakeConductor();
    const gw = createGateway(adapter, conductor);

    await gw.handleInbound(inbound({ externalId: 'm1' }));
    const convId = sendTurn.mock.calls[0]![0] as string;
    emit(convId, { type: 'system', subtype: 'stop_hook_summary', uuid: 's1', timestamp: 't' });

    await gw.handleInbound(inbound({ externalId: 'm2', text: 'follow up' }));

    expect(sendTurn).toHaveBeenCalledTimes(2);
    expect(sendTurn.mock.calls[1]![0]).toBe(convId);
    expect(conductor.startConversation).toHaveBeenCalledTimes(1);
  });

  it('an unbound channel keeps the throwaway-conversation behaviour (no agent involved)', async () => {
    // No agent bound to this channel/thread at all.
    const { adapter } = fakeAdapter();
    const { conductor, sendTurn } = fakeConductor();
    const gw = createGateway(adapter, conductor);

    await gw.handleInbound(inbound());

    expect(sendTurn).toHaveBeenCalledTimes(1);

    // No agent involved — the conductor is started with no systemPrompt override
    // (today's throwaway-conversation behaviour, unchanged).
    const startCall = (conductor.startConversation as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(startCall[2]).toBeUndefined();
  });

  it('worker report_complete (relayed via pushToConversation) reaches a bound channel (Task 6)', async () => {
    createAgent({
      name: 'Ops Agent',
      system_prompt: 'You watch prod.',
      channel: 'telegram',
      channel_config: JSON.stringify({ threadKey: 'chat-1' }),
    });

    const { adapter, sent } = fakeAdapter();
    const { conductor, sendTurn } = fakeConductor();
    const gw = createGateway(adapter, conductor);

    // Establish the thread (registers the gateway's conversation-message listener).
    await gw.handleInbound(inbound());
    const convId = sendTurn.mock.calls[0]![0] as string;

    // Simulate the supervisor relaying a worker's phase-complete report — the
    // exact path that used to be WS-only (`pushToConversation`) and never
    // reached the gateway before this fix.
    pushToConversation(
      convId,
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        text: '[supervisor] task `t1` plan ready — review and approve to begin implementation.',
      }),
    );
    pushToConversation(
      convId,
      JSON.stringify({
        type: 'card',
        id: 'card-1',
        command: 'approve-plan',
        args: {
          task_id: 't1',
          plan_path: 'plan.json',
          artifact_url: '/api/orchestrator/artifact?task=t1&path=plan.json',
        },
      }),
    );

    await new Promise((r) => setTimeout(r, 0));

    expect(sent.map((s) => s.text)).toEqual([
      '[supervisor] task `t1` plan ready — review and approve to begin implementation.',
      '[t1] plan ready for review: /api/orchestrator/artifact?task=t1&path=plan.json',
    ]);
  });

  it('a card with args.summary sends the summary as payload — link only a trailing ref', async () => {
    createAgent({
      name: 'Ops Agent',
      system_prompt: 'You watch prod.',
      channel: 'telegram',
      channel_config: JSON.stringify({ threadKey: 'chat-1' }),
    });

    const { adapter, sent } = fakeAdapter();
    const { conductor, sendTurn } = fakeConductor();
    const gw = createGateway(adapter, conductor);
    await gw.handleInbound(inbound());
    const convId = sendTurn.mock.calls[0]![0] as string;

    pushToConversation(
      convId,
      JSON.stringify({
        type: 'card',
        id: 'card-1',
        command: 'approve-plan',
        args: {
          task_id: 't1',
          plan_path: 'plan.json',
          artifact_url: '/api/orchestrator/artifact?task=t1&path=plan.json',
          summary: 'Add a widget.\n\nFiles:\n• src/widget.ts — create',
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(sent).toHaveLength(1);
    const text = sent[0]!.text;
    // Summary is the payload; the URL is a trailing secondary ref, never alone.
    expect(text).toContain('Add a widget.');
    expect(text).toContain('src/widget.ts — create');
    expect(text).toContain('(ref: /api/orchestrator/artifact?task=t1&path=plan.json)');
    expect(text).not.toBe(
      '[t1] plan ready for review: /api/orchestrator/artifact?task=t1&path=plan.json',
    );
  });

  it('start() pre-registers the proactive relay for a bound agent — a supervisor push reaches the channel with NO prior inbound (survives restart)', async () => {
    const agentId = createAgent({
      name: 'Ops Agent',
      system_prompt: 'You watch prod.',
      channel: 'telegram',
      channel_config: JSON.stringify({ threadKey: 'chat-1' }),
    });
    // The agent's persistent conversation already exists (as it would after a
    // restart) with a transcript path but no live thread in memory.
    const convId = createConversation({ title: 'Ops Agent', agent_id: agentId });
    updateConversation(convId, { transcript_path: `/fake/${convId}.jsonl` });

    const { adapter, sent } = fakeAdapter();
    const { conductor, sendTurn } = fakeConductor();
    const gw = createGateway(adapter, conductor);

    // Boot only — the owner has NOT messaged the bot in this process.
    await gw.start();
    expect(sendTurn).not.toHaveBeenCalled();

    pushToConversation(
      convId,
      JSON.stringify({ type: 'message', role: 'assistant', text: '[supervisor] task `t9` done' }),
    );
    await new Promise((r) => setTimeout(r, 0));

    // Before this fix nothing was relayed until the owner DMed the bot again.
    expect(sent.map((s) => s.text)).toEqual(['[supervisor] task `t9` done']);
  });

  it('persists lastThreadKey for a channel-wide bound agent so a later boot can reach it', async () => {
    process.env.OCTOMUX_GATEWAY_SLACK_ALLOW = ALLOWED;
    const agentId = createAgent({
      name: 'Slack Orchestrator',
      system_prompt: 'coordinate',
      channel: 'slack',
      channel_config: null, // channel-wide binding: no threadKey yet
    });

    const { adapter } = fakeAdapter();
    const { conductor } = fakeConductor();
    const gw = createGateway(adapter, conductor);

    await gw.handleInbound(inbound({ channel: 'slack', threadKey: 'D123', externalId: 's1' }));

    const cfg = JSON.parse(getAgent(agentId)!.channel_config!) as { lastThreadKey?: string };
    expect(cfg.lastThreadKey).toBe('D123');
    // Binding stays channel-wide (no `threadKey` written), so it still matches any thread.
    expect((cfg as { threadKey?: string }).threadKey).toBeUndefined();
  });
});
