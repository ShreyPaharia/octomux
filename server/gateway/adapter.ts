export interface InboundMessage {
  channel: 'telegram' | 'slack';
  threadKey: string; // Telegram chat.id, later Slack thread_ts
  senderId: string; // Telegram from.id, later Slack user_id
  externalId: string; // Telegram update_id, later Slack event_id — for dedup
  text: string;
}

export interface ChannelAdapter {
  id: 'telegram' | 'slack';
  start(onMessage: (m: InboundMessage) => Promise<void>): Promise<void>;
  send(threadKey: string, text: string): Promise<void>;
  sendTyping(threadKey: string): Promise<void>;
}
