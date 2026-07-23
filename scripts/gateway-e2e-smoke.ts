/* eslint-disable no-console -- CLI smoke script: console output is the interface */
/**
 * scripts/gateway-e2e-smoke.ts
 *
 * End-to-end smoke test for the Telegram gateway with ONLY the Telegram
 * transport mocked — everything downstream is REAL: the gateway glue, an
 * isolated SQLite DB, and a live `claude` conductor in tmux with its transcript
 * tail. It injects a fake inbound message and waits for the conductor's reply to
 * come back out through the outbound path.
 *
 * This exercises exactly the parts that unit tests (mocked conductor) cannot:
 * session launch, the boot-race liveness wait, the transcript tail, the
 * stop-hook turn boundary, redaction, and the outbound queue.
 *
 * Run:  npx tsx scripts/gateway-e2e-smoke.ts
 * Needs: an authed `claude` CLI + tmux (same as running octomux normally).
 * Exit:  0 = a reply came back; 1 = timed out / no reply.
 */

import os from 'os';
import path from 'path';
import fs from 'fs';

// Isolate: throwaway DB + a known allowlisted sender. MUST be set before any
// server module (db.ts resolves the DB path at import time).
const TMP_DB = path.join(os.tmpdir(), `octomux-gw-e2e-${process.pid}.db`);
process.env.OCTOMUX_DB_PATH = TMP_DB;
const SENDER = 'e2e-user';
process.env.OCTOMUX_GATEWAY_TELEGRAM_ALLOW = SENDER;

const TIMEOUT_MS = 75_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<number> {
  const { createGateway } = await import('../server/gateway/gateway.js');
  const { getDb } = await import('../server/db.js');
  const { getThreadConv } = await import('../server/repositories/gateway.js');
  const { stopConversation } = await import('../server/orchestrator/runner.js');
  const { getConversation } = await import('../server/orchestrator/store.js');
  const { execTmux } = await import('../server/tmux-bin.js');
  const type = await import('../server/gateway/adapter.js');

  const tmuxCap = async (t: string, fmt: string) =>
    execTmux(['display-message', '-t', t, '-p', fmt])
      .then((r) => r.stdout.trim())
      .catch((e) => `ERR(${(e as Error).message.slice(0, 40)})`);

  getDb(); // force schema + migrations on the throwaway DB
  console.log(`[e2e] isolated DB: ${TMP_DB}`);

  // ── Mock ONLY the Telegram transport ──────────────────────────────────────
  const sent: Array<{ threadKey: string; text: string }> = [];
  let onMessage: ((m: type.InboundMessage) => Promise<void>) | null = null;
  const adapter: type.ChannelAdapter = {
    id: 'telegram',
    start: async (h) => {
      onMessage = h;
    },
    send: async (threadKey, text) => {
      sent.push({ threadKey, text });
      console.log(`[e2e] ◀ OUTBOUND reply (${text.length} chars):\n${text}\n`);
    },
    sendTyping: async () => {},
  };

  const gateway = createGateway(adapter);
  await gateway.start();
  if (!onMessage) throw new Error('adapter.start did not register a handler');

  // ── Inject a fake inbound message ─────────────────────────────────────────
  const threadKey = `e2e-${Date.now()}`;
  console.log('[e2e] ▶ injecting inbound message…');
  await onMessage({
    channel: 'telegram',
    threadKey,
    senderId: SENDER,
    externalId: 'e2e-update-1',
    text: 'Reply with a short greeting so I know you are alive — one sentence, no task needed.',
  });

  // ── Diagnostics: what did the conductor actually do? ──────────────────────
  const convId = getThreadConv('telegram', threadKey);
  const conv = convId ? getConversation(convId) : null;
  console.log('[e2e] conversation:', {
    convId,
    tmux: conv?.tmux_window,
    session: conv?.claude_session_id?.slice(0, 12),
    transcript: conv?.transcript_path,
  });

  // ── Wait for the conductor's reply to flow back out ───────────────────────
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline && sent.length === 0) {
    await sleep(5000);
    const pane = conv?.tmux_window
      ? await tmuxCap(conv.tmux_window, '#{pane_current_command}')
      : 'n/a';
    const tp = conv?.transcript_path;
    const tExists = tp ? fs.existsSync(tp) : false;
    const tLines = tExists ? fs.readFileSync(tp!, 'utf8').split('\n').filter(Boolean).length : 0;
    console.log(
      `[e2e] pane=${pane} transcript=${tExists ? tLines + ' lines' : 'MISSING'} outbound=${sent.length}`,
    );
  }

  // Dump what claude is showing in its pane (reveals auth / MCP / prompt errors).
  if (conv?.tmux_window) {
    const pane = await execTmux(['capture-pane', '-t', conv.tmux_window, '-p'])
      .then((r) => r.stdout)
      .catch((e) => `capture failed: ${(e as Error).message}`);
    console.log('[e2e] ── conductor pane (last 25 lines) ──');
    console.log(pane.split('\n').slice(-25).join('\n'));
    console.log('[e2e] ────────────────────────────────────');
  }

  const ok = sent.length > 0;
  console.log(
    ok ? '[e2e] ✅ PASS — reply received end to end' : '[e2e] ❌ FAIL — no reply in time',
  );

  // ── Cleanup: stop the conductor session, drop the temp DB ─────────────────
  try {
    const convId = getThreadConv('telegram', threadKey);
    if (convId) {
      await stopConversation(convId);
      console.log('[e2e] stopped conductor session for', convId);
    }
  } catch (err) {
    console.log('[e2e] cleanup warning:', (err as Error).message);
  }
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(TMP_DB + suffix);
    } catch {
      /* ignore */
    }
  }

  return ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[e2e] ERROR:', err);
    process.exit(1);
  });
