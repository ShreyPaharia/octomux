# Terminal perf: remote deflate + half-open socket watchdog

## Intent

Remote (devbox-over-network) terminal viewing was laggy — slow tab switches,
scroll/typing trailing in — and terminals occasionally froze until a manual
page refresh. Two root causes, both fixed here:

1. **WebSocket compression was a silent no-op.** `server/terminal.ts` passed
   `perMessageDeflate: true` to `WebSocketServer`, relying on it for "~10x"
   bandwidth savings on repetitive TUI repaints. Under Bun the `ws` npm package
   is replaced by Bun's built-in shim, which accepts the option but never
   negotiates the extension (explicit `TODO` in the shim; verified with a raw
   handshake probe — the 101 response carries no `Sec-WebSocket-Extensions`).
   Every full-screen repaint went uncompressed, saturating slow links.
2. **Half-open sockets froze terminals.** A NAT/proxy drop or laptop sleep
   leaves the browser socket reporting OPEN forever; `onclose` never fires, so
   the reconnect logic never runs. The server heartbeat reaps its own side, but
   the client stays wedged until refresh.

Also removes the "give it a readable name" nudge that was appended to every
agent's initial prompt (separate commit, requested alongside).

## Change tour

**App-level compression (replaces the dead permessage-deflate):**

- `server/terminal.ts` — `sendFrame()` deflates (`deflateRawSync`) any output
  frame ≥ 1KB into a binary frame when the client opted in via `?deflate=1`;
  smaller frames stay plain text so keystroke echo never pays the zlib
  round-trip. Applied on all three send paths: the coalesced pty flush, the
  initial capture-pane snapshot, and chat terminals. The upgrade handler now
  splits the query string off `req.url` before route matching.
- `src/lib/terminal-frames.ts` (new) — client-side frame decoding.
  `inflateFrame()` uses the browser-native `DecompressionStream('deflate-raw')`
  (no new dependency). `makeFrameWriter()` preserves arrival order across async
  inflation with a promise chain; text frames bypass the chain when nothing is
  pending, so echo stays synchronous. A corrupt frame is dropped without
  wedging subsequent frames.
- `src/components/TerminalView.tsx` — advertises support (`?deflate=1` when
  `DecompressionStream` exists), sets `binaryType = 'arraybuffer'`, routes
  `onmessage` through a per-socket frame writer.

**Liveness watchdog (fixes the hangs):**

- `src/components/TerminalView.tsx` — after 15s of link silence the client
  sends `{"type":"ping"}`; if nothing arrives within 5s the socket is half-open
  and gets silently replaced (no overlay; the reconnect repaints from the tmux
  snapshot). On tab return, an OPEN socket is probed immediately instead of
  trusted — post-sleep sockets often only *look* OPEN.
- `server/terminal.ts` — replies to `{"type":"ping"}` with an empty frame.
  Empty writes are a no-op for xterm, so the client needs no filtering; paused
  (hidden-tab) connections still answer because `paused` only gates pty output,
  not control messages.

**Prompt nudge removal:**

- `server/task-engine/launch.ts` — `buildAgentStartupCommand` writes the
  initial prompt verbatim; the appended `octomux task rename` hint is gone.
  Signature unchanged, all callers unaffected; the rename nudge still reaches
  agents via the update-task-status skill.

## Risk & blast radius

- Protocol change is negotiated: clients without `DecompressionStream` (or old
  cached bundles) never send `?deflate=1` and get the exact old behavior.
- Frame ordering under async inflation is the subtle invariant; it's enforced
  by `makeFrameWriter`'s pending counter and covered by dedicated ordering
  tests (including corrupt-frame recovery).
- Known, accepted low-risk gap (from the pre-PR adversarial review): a frame
  still inflating when its socket is replaced could theoretically write after
  the new socket's snapshot. The window requires an in-flight inflate to
  overlap a reconnect that itself waits ≥1s backoff — fix only if repaint
  corruption is ever observed.
- Watchdog false positives would cause a silent reconnect (snapshot repaint),
  not data loss; pings are answered even for paused hidden tabs.

## Testing

- `server/terminal.test.ts` — 26/26 pass; 5 new: deflate roundtrip
  (`inflateRawSync` on the binary frame), sub-threshold stays text, no-opt-in
  stays text, large snapshot deflated, ping answered without reaching the pty.
- `src/lib/terminal-frames.test.ts` (new) — 6 tests: roundtrip, sync text fast
  path, ordering behind in-flight inflation, multi-frame ordering, corrupt
  frame recovery. Poll-based waits (no fixed sleeps) so they hold under
  parallel load.
- `src/components/TerminalView.test.tsx` — 17/17 pass; 4 new: deflate flag in
  URL, unanswered-ping reconnect, answered-ping keeps socket, tab-return probe.
- Full client suite: 1273 pass; the 1–2 failures (HomePage composer-hydration,
  Composer preflight) are pre-existing load flakes — they pass in isolation and
  fail identically with this branch's changes stashed.
- Full server suite has pre-existing failures on `next` (API 500s,
  `server/plugins/loader` typecheck errors) — reproduced with changes stashed.
- Live probes against bun 1.3.14 confirmed: shim negotiates no deflate,
  `Bun.serve` does, empty text frames round-trip, `bufferedAmount` reports real
  backpressure (so the existing coalescing logic still works).
