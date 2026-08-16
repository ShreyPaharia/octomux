export interface InboundMessage {
  channel: 'telegram' | 'slack';
  threadKey: string; // Telegram chat.id, later Slack thread_ts
  senderId: string; // Telegram from.id, later Slack user_id
  externalId: string; // Telegram update_id, later Slack event_id — for dedup
  text: string;
}

/** A block-actions button click (Slack-only in v1 of interactivity). */
export interface InboundAction {
  channel: 'telegram' | 'slack';
  /** Channel/DM id the interactive message lives in. */
  threadKey: string;
  senderId: string;
  /** envelope_id — for dedup. */
  externalId: string;
  actionId: string;
  /** The clicked button's raw `value` payload. */
  value: string;
  /** ts of the message carrying the buttons — for chat.update. */
  messageTs: string;
  /** The message's current blocks — callers patch and update in place. */
  blocks: unknown[];
}

export interface ChannelAdapter {
  id: 'telegram' | 'slack';
  start(
    onMessage: (m: InboundMessage) => Promise<void>,
    onAction?: (a: InboundAction) => Promise<void>,
  ): Promise<void>;
  send(threadKey: string, text: string): Promise<void>;
  sendTyping(threadKey: string): Promise<void>;
  /** Edit a previously-sent message in place. Absent on channels without edit APIs. */
  updateMessage?(threadKey: string, ts: string, text: string, blocks?: unknown[]): Promise<void>;
}
