# octomux — launch copy

Two launches. **Launch 1** (below) is the original product launch. **Launch 2**
is the plugin-ecosystem launch — a different job with a different audience.

Launch 1 — two drafts: an X/Twitter thread (built around the demo gif) and a Show HN post.
Both follow what's worked for open-source dev-tool launches: plain descriptive
framing, a real problem stated honestly, no superlatives, a link to the repo,
and an invitation for feedback rather than a sales pitch.

---

## X / Twitter thread

Voice: a dev showing something he built for himself and actually uses daily.
First person, honest, a little nerdy-excited. No "introducing", no "thrilled to
announce", no superlatives. Show the thing, share the reasoning, ask a question.

**Tweet 1 — the hook (attach the demo gif/mp4)**

I kept ending up with 5 Claude Code agents running and no idea what any of them
had actually done.

so I built a little local dashboard to keep track. been using it every day for
weeks — finally cleaned it up to share.

it's called octomux 🧵

> Tip: the gif is the hook. Let it autoplay; the first 2s (prompt → 5 agents spawning) does the selling.

**Tweet 2 — the actual problem**

spinning up parallel agents is easy now. that part's solved.

the mess is _after_: which one finished? what did it change? which one's stuck
waiting on a "allow this?" I never saw? I had terminals everywhere and zero
sense of what was safe to merge.

**Tweet 3 — what it does (1)**

so the loop I wanted: type a task, pick Claude or Cursor, it runs on its own
branch. point it at my GitHub issues and it opens a task per issue.

watching 5 agents fan out from one prompt still feels a bit unreal tbh.

**Tweet 4 — what it does (2)**

then one screen to watch them all — no digging through tmux panes.

when one's done I read the diff right there, tick off files, leave comments, hit
Ship. it opens the PR. I stopped tab-hopping to GitHub mid-review and honestly
that alone was worth it.

**Tweet 5 — the bit I didn't expect to love**

the agents move their own cards — Human review when they finish, PR when one
opens, Done when it merges — and push that to Jira (Linear too).

I genuinely haven't manually updated a ticket in weeks. didn't realize how much
that was costing me until it stopped.

**Tweet 6 — how I actually use it**

it's not vibe coding. I still read every diff and own every merge — I just don't
babysit the typing anymore.

favorite trick: finish a task with Claude, drop Cursor on the same branch to
review the diff. a second model catches stuff the first one talked itself into.

**Tweet 7 — the thinking behind it**

I deliberately didn't touch the agent itself. Claude Code / Cursor keep getting
better and I don't want to compete with that.

what _doesn't_ change is the stuff around the code — tasks, review, telling the
team what shipped. that's the slow, annoying part, so that's what I built for.
git is the engine; this is the GitHub-ish layer on top. all local.

**Tweet 8 — "isn't this just X?" (be honest)**

yeah, fair — Vibe Kanban, Conductor, Claude Code's own sessions all overlap.

closest is probably Vibe Kanban (it's good). where I went further: the tracker
auto-sync, agents messaging + spawning each other, and staying both cross-vendor
(Claude _or_ Cursor) and fully local/MIT. if the built-in sessions cover you, you
might not need this at all.

**Tweet 9 — the honest caveats**

it's early and opinionated:

- macOS only right now
- single-user / local — no hosted team view
- runs on tmux + git worktrees under the hood
- no proper cost view yet (on the list)

sharing it anyway because it's been genuinely useful to me.

**Tweet 10 — CTA**

it's free + open source (MIT):

npm install -g octomux && octomux start

repo: github.com/ShreyPaharia/octomux

would love for you to break it and tell me how. what's the most agents you've
had running at once — and where does keeping track of them fall apart for you?

---

## Show HN post

**Title:**

Show HN: Octomux – Local dashboard to run Claude Code and Cursor agents in parallel

**Body:**

Hi HN — I'm Shrey. octomux is a free, open-source dashboard that runs on your
Mac for managing parallel coding agents (Claude Code or Cursor). It gives you
one place to watch agents run, answer their permission prompts, read the diffs,
and open PRs.

The problem I kept hitting: spinning up parallel agents is well-served now, but
catching up to them isn't. Once I had five Claude Code sessions going, I'd lose
track of which task was done, what each one changed, and which one was blocked
waiting on a "yes/no" prompt buried in some terminal. The bottleneck moved from
writing code to reviewing it — knowing what shipped and why.

How it works: you describe a task (or paste a ticket link), pick Claude or
Cursor, and each task runs on its own git branch so agents don't step on each
other — five agents can edit the same filename in parallel without colliding.
A board shows status across Backlog → In progress → Human review → PR → Done,
and every permission prompt lands in a single inbox instead of ten terminals.
When a task's done you read the diff inside the app, leave comments if you want,
and hit Ship to open the PR — no tab-hopping to GitHub mid-review.

What's different from just running tmux + a few agents yourself: it's built
around the review step, not the spawn step. Branch-per-task isolation, an inbox
for "allow this?" prompts, in-app diff review, and the ability to add a second
agent on the same branch to review the first one's diff. You can also queue the
next task so an agent picks up new work when it finishes.

One design decision I want to be explicit about: octomux doesn't try to be a
better agent, and it deliberately doesn't touch the harness. Claude Code, Cursor,
whatever comes next — that layer is moving fast, it's where the vendors are
competing, and I don't want to compete with it or lock you to one. What barely
moves, regardless of which harness you use, is everything _around_ the coding:
breaking work into tasks, tracking what's running, reviewing diffs before they
land, and keeping the rest of the team in the loop on what shipped. That's where
the time actually goes once you're running several agents at once. So octomux is
a harness for _that_ layer — the workflow around the code — and any coding agent
plugs into it. The mental model I keep coming back to is git vs GitHub: the agent
writes the code; octomux is where you manage it, review it, and ship it. All on
your machine.

Concretely, that's where most of the features live. When an agent finishes it
flips its task to Human review, to PR when it opens one, and to Done when it
merges — and it syncs that status to your tracker (Jira today, Linear too) so
you're not hand-updating tickets. Review isn't just a raw diff: the agent can
leave a walkthrough, group the files, and drop comments that render inline with
the code. Agents can message each other and spawn their own tasks, so one prompt
can fan out into an epic of independently-mergeable subtasks, and an agent can
look at the history and status of everything else on the board before it acts.
Because the harness sits behind an abstraction, adding another agent — or
another tracker — is a config/plugin concern rather than a rewrite. And the
whole thing is reboot-proof: close the laptop and `octomux start` brings back
every task, branch, terminal, and review state exactly as it was.

How it compares to what's out there: there are good tools in this space now —
Vibe Kanban, Conductor, Crystal, Claude Squad — and Claude Code itself has been
adding native parallel-session management. I've used several of them. Most are
strong on the spawn/orchestrate side; octomux deliberately spends its complexity
on the review-and-merge side instead — reading diffs in-app, an inbox for
prompts, a second agent reviewing the first's diff. Two other deliberate choices:
it's agent-agnostic (Claude Code _or_ Cursor, picked per task, so you're not
locked to one vendor), and it's fully local and MIT — no cloud, no account,
nothing that can get sunset out from under you. If Claude Code's built-in
sessions already cover your workflow, you may not need this; it's aimed at people
running enough parallel work that the catching-up is the bottleneck. Genuinely
curious where people land on that.

To be upfront about the limits: it's macOS-only today, it's single-user and
local (no hosted team view), it leans on tmux + git worktrees under the hood, and
a first-class cost/usage view is still on the roadmap. If Claude Code's built-in
sessions already cover how you work, you may not need this at all.

Some specifics:

- Runs entirely locally. No cloud, no telemetry, your code never leaves the laptop.
- Same flow whether you run one agent or five.
- Survives reboots — `octomux start` restores your tasks and review progress.
- Stack: Node, tmux + git worktrees under the hood, xterm.js terminals in the UI.
- MIT licensed. You only pay for Claude Code or Cursor themselves.

Install:

npm install -g octomux && octomux start

Repo: https://github.com/ShreyPaharia/octomux

It's early and I'm sure there are rough edges — I'd really like feedback on the
review flow specifically, and on whether branch-per-task holds up for how you
actually run agents. What's the largest number you've run in parallel, and
where does keeping track of them fall apart for you today?

---

# Launch 2 — the plugin ecosystem

A feature launch, not a product launch. Different job: the first one asked
people to try a thing, this one asks them to build on it. The ask is the point —
lead with the seam, not the announcement.

Honest framing, because it's checkable: plugins run **in-process with full Node
privileges**. There is no sandbox. Say it before someone else does.

---

## X / Twitter thread — plugins

**Tweet 1**

octomux runs Claude Code and Cursor. people kept asking for Aider, Codex,
Gemini CLI, their own internal harness.

so I stopped adding harnesses and made the harness a plugin.

**Tweet 2**

turns out the three seams octomux's own features are built on are the three
worth exposing:

- workflows — the thing a cron schedule runs
- integrations — Jira, Linear, Slack, and whatever you use instead
- harnesses — the agent itself

a plugin registers into the same registries the built-ins do. no second-class API.

**Tweet 3** (attach a screenshot of the code)

a whole plugin:

```js
export function apply(ctx) {
  ctx.harnesses.register({ id: 'aider' /* ... */ });
}
```

an npm package, a row in ~/.octomux/octomux.yml, restart. `octomux doctor`
tells you if it loaded.

**Tweet 4**

the part I actually cared about getting right: one bad plugin can't take down
your boot.

resolve, import and apply each run under a timeout. a plugin that throws, hangs,
or hands back a malformed payload lands in a load report — the server still
starts. `--safe-mode` skips every plugin row if you need it.

**Tweet 5**

fair warning, stated plainly: a plugin runs in-process with full node
privileges. there's no sandbox. installing one is running its code — treat it
like any dependency.

**Tweet 6 — the ask**

I wrote up ~15 plugin ideas I'd merge tomorrow, marked which are good first
issues:

github.com/ShreyPaharia/octomux/blob/main/PLUGIN-IDEAS.md

authoring guide: /docs/plugins

what harness or tracker do you use that nothing supports?

---

## Show HN post — plugins

**Title:**

Show HN: Octomux is now a plugin metaharness – add your own agent harness

**Body:**

Hi HN — Shrey again. I posted octomux here a while back: a local dashboard for
running Claude Code and Cursor agents in parallel, each in its own git worktree.

The most common reply was some version of "does it support X" — Aider, Codex,
Gemini CLI, OpenHands, someone's internal wrapper. I added Cursor by hand and
realised I'd be doing that forever.

So instead of adding harnesses, I made the harness a plugin. A plugin is an npm
package listed in ~/.octomux/octomux.yml. At boot it gets `apply(ctx)` and can
register into three registries:

- **workflows** — what a cron schedule actually runs
- **integrations** — issue trackers, chat, notifications
- **harnesses** — the coding agent itself

These aren't a bolted-on extension API. They're the same three registries the
built-in features register into — Jira and the Claude Code harness go through
the same doors a plugin does.

The design constraint I spent most of the time on: a plugin must not be able to
break boot. Resolve, import and apply each run under a timeout; failures land in
a load report with a phase instead of throwing; a plugin whose `apply()` overruns
gets its context revoked so it can't register late. `octomux doctor` reads that
report from disk, so it works even when the server won't start. `--safe-mode`
skips plugin rows entirely.

Two things I'd rather you heard from me: plugins run in-process with full Node
privileges and there is no sandbox — installing one is equivalent to running its
code. And plugin ids are namespaced (`<row-id>:<name>`), so a plugin can't
shadow a built-in, but two plugins can still disagree about the world.

Everything's MIT, runs locally, no telemetry.

Authoring guide: github.com/ShreyPaharia/octomux/tree/main/docs/plugins
Ideas I'd merge, with good-first-issue markers: /PLUGIN-IDEAS.md

I'd genuinely like to be told the plugin API is wrong while it's still version 0. What's the seam you'd need that isn't there — and for those of you who've
maintained one of these: what did you wish you'd made pluggable before people
started depending on it?

---

## Posting notes — launch 2

- **Different audience than launch 1.** Launch 1 sold a dashboard to people
  drowning in agents. This one recruits builders. Don't reuse the demo gif as
  the hook — the code sample is the hook.
- **Lead with the ask.** A plugin ecosystem with no plugins is a press release.
  The PLUGIN-IDEAS list with good-first-issue markers is the most important
  link in either post; put it where people will actually reach it.
- **Say the security thing first.** "In-process, no sandbox" will come up in the
  comments regardless. Saying it yourself converts an attack into credibility.
- **Expect "why not WASM / a subprocess?"** Real answer: a harness plugin has to
  hand back live command builders that core calls on the hot path, so
  serialising the boundary would change the contract. Worth saying plainly
  rather than hedging.
- **Don't claim an ecosystem yet.** Say "the API is version 0 and I want it
  broken." Overclaiming adoption is the fastest way to lose this crowd.
- **Have 2-3 example plugins ready to link** before posting. "Build one" lands
  much harder when there's something to copy.

---

## Posting notes — launch 1

- **HN title:** keep it descriptive, no superlatives. "Local dashboard to run
  Claude Code and Cursor agents in parallel" tells people exactly where the
  link goes. Optionally append "(open source)" if you want to signal it early.
- **HN timing:** weekday mornings US Pacific (roughly 7–9am PT) tend to do best;
  be at your keyboard to answer comments fast for the first few hours.
- **HN comments:** answer technical questions in depth, agree with the kernel of
  truth in any criticism, and don't have friends post booster comments — HN
  detects and punishes it.
- **X thread:** the gif does the heavy lifting on tweet 1. Native video/gif
  upload (don't make people click out). Pin the thread; reply to the last tweet
  with the repo link again a few hours in.
- **Cross-link sparingly:** fine to post both, but don't link the HN thread from
  X asking for upvotes — HN frowns on vote solicitation.
