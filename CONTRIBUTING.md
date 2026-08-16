# Contributing

## Development Setup

```bash
bun install
bun run dev      # starts Express (port 7777) + Vite dev server concurrently
```

### Tech Stack

- **Frontend:** Vite + React 19 + Tailwind CSS 4 + shadcn/ui + React Router 7
- **Backend:** Express 5 + `bun:sqlite` (WAL mode) + `Bun.Terminal` + ws
- **Terminal:** xterm.js (bidirectional) → `Bun.Terminal` (`server/pty.ts`) → `tmux attach`
- **Isolation:** git worktrees per task, tmux sessions per task, tmux windows per agent
- **IDs:** nanoid(12)
- **Runtime:** bun — everywhere. Package manager, script runner, dev server, test
  runner, and the compiler that produces the shipped binary. There is no Node in
  the build or at runtime.

## Architecture

```
server/           Express backend (API, terminal streaming, task lifecycle, DB)
  api.ts          REST routes mounted on Express app
  app.ts          extracted createApp() for testability
  task-runner.ts  worktree + tmux + claude lifecycle (closeTask, deleteTask)
  db.ts           SQLite singleton with getDb() / setDb() / initDb()
  types.ts        shared types (Task, Agent, TaskStatus, AgentStatus)
src/              React SPA (pages, components, lib/api.ts)
cli/              CLI tool for task management
e2e/              Playwright E2E tests
```

## Task Lifecycle

```
draft → setting_up → running → closed / error
```

Each task gets a git worktree at `<repo>/.worktrees/<id>`, a tmux session `octomux-agent-<id>`, and a branch `agents/<id>`. Each agent runs in a tmux window within the session.

- **Close** — stops agents and kills the tmux session. Worktree and branch are preserved for resume.
- **Delete** — kills tmux session, removes worktree, deletes branch, removes DB rows. Full cleanup.

## Testing

```bash
bun run test           # all three suites below
bun run test:server    # server/ + cli/review     (bun test)
bun run test:client    # src/                     (bun test + happy-dom)
bun run test:units     # cli/src, packages, bin   (bun test)
bun run test:e2e       # Playwright E2E tests (auto-starts servers)
bun run test:e2e:ui    # Playwright interactive UI mode
```

### Testing Patterns

- `bun test`, not vitest. Tests keep their vitest _shape_ — `describe/it/expect/vi`
  — via `server/bun-test.ts`, a compatibility shim. Import from it, never from
  `vitest`:

  ```ts
  import { describe, it, expect, vi } from './bun-test.js';
  ```

  `src/` tests import `src/bun-test.ts`, which re-exports the same surface.

- **`vi.mock()` does not hoist.** vitest lifts mocks above every import; bun's
  `mock.module()` runs in statement order, and a static `import` is hoisted
  regardless of where it sits in the file. So the module under test must be
  loaded _after_ the mocks:

  ```ts
  vi.mock('./dep.js', () => ({ thing: vi.fn() }));

  const { subject } = await import('./subject.js'); // not a static import
  ```

- **Mock factories must be synchronous.** An `async` factory deadlocks when the
  mocked module is imported synchronously. `importOriginal()` and
  `vi.importActual()` return the module directly for this reason — no `await`.
- **Mock order matters** when one mock's factory loads real modules: mock
  `child_process` before anything whose module scope captures `execFile`.
- Suites run with `--parallel`, which implies `--isolate`. Without it
  `mock.module()` registrations leak between files in the shared process.
- `NODE_ENV=test` is set by the test scripts (bun does not set it) — without it
  the suite runs in production mode against the real `~/.octomux`.
- Table-driven tests using `it.each()` — prefer over individual test cases
- Shared test harness: `server/test-helpers.ts` (DEFAULTS fixtures, insert/get helpers, shell mock assertion helpers via `findExecCall`/`countExecCalls`)
- DB tests use in-memory SQLite via `createTestDb()` → calls `setDb()` for isolation
- task-runner tests mock `child_process` (execFile, spawn) and `fs` (existsSync, mkdirSync, copyFileSync)
- API tests use supertest against `createApp()`
- Frontend test helpers in `src/test-helpers.tsx`: `makeTask()`, `renderWithRouter()`, `mockApi()`
- The DOM is happy-dom, registered in `src/bun-test-setup.ts` (passed via
  `--preload`). It also stubs `IntersectionObserver`/`ResizeObserver` (happy-dom
  ships both but neither ever fires) and `WebSocket`, and sets the origin to
  `http://localhost/` so `history.replaceState` works.

### E2E Notes

- Playwright tests in `e2e/`, config in `playwright.config.ts`
- `webServer` config auto-starts Express + Vite, reuses running servers in dev
- Helpers in `e2e/helpers.ts` — `createTaskViaAPI`, `waitForStatus`, `deleteAllTasks`, `fillCreateDialog`
- base-ui Dialog dismisses on Playwright `fill()` — use `click({force:true})` + `pressSequentially` instead
- Terminal text leaks into locators — use `getByRole` or `.filter()` to avoid strict mode violations

## Code Style

```bash
bun run lint           # ESLint 9 flat config
bun run lint:fix       # auto-fix lint issues
bun run format         # Prettier
bun run format:check   # check formatting
bun run typecheck      # tsc --noEmit
bun run build          # workspace packages + the compiled binary
```

- Prettier: single quotes, trailing commas, 100 char width, semicolons
- ESLint: `@typescript-eslint/no-explicit-any` is warn (off in test files)
- Conventional commits enforced: `feat(scope): message`, `fix(scope): message`, etc.
- Kebab-case scopes, 100 char header max

## Build & Distribution

octomux ships as a **compiled Bun binary**, one per platform. There is no
`dist-server/` and no separate `cli/` build — `bun build --compile` bundles
`bin/main.js` (server, CLI, and SPA assets) into a single executable.

```bash
bun run build:binary       # this host only → dist-bin/octomux
bun run build:binary:all   # all six targets
bun run build:npm          # build all + sign + stage dist-npm/
```

Assets that must exist as real files at runtime — `skills/`, `agents/`,
`templates/`, `workflows/`, and the built `dist/` SPA — can't live inside the
read-only `/$bunfs`, so `scripts/bundle-assets.mjs` embeds them as base64 and
`server/assets.ts` unpacks them to `~/.octomux/runtime/<version>/` on first run.
`assetRoot()` is the only correct way to reach them; `__dirname` is not.

### Publishing

The npm package carries no program — just a launcher and the assets. The binary
comes from `@octomux/cli-<platform>-<arch>` optional dependencies, which npm
filters by `os`/`cpu`/`libc`. `scripts/install-binary.cjs` (postinstall) then
hardlinks the matching binary over the `bin/octomux` placeholder, so `octomux`
execs native code with no Node process resident. `bin/cli-wrapper.cjs` is the
fallback for installs that skipped postinstall.

```bash
bun run build:npm
npm publish dist-npm/cli-darwin-arm64      # …and the other five
npm publish                                # root package last
```

Publish the platform packages **before** the root package — its
`optionalDependencies` pin the exact version.

Those pins are **not** in the checked-in `package.json`: the `@octomux/cli-*`
packages only exist on npm once a release has published them, so pinning them in
the repo would make `bun install` 404 on a fresh clone. `build:npm` writes them
into the manifest at release time, which is why it leaves `package.json`
showing a local edit.

### Signing

`bun run sign:macos` ad-hoc signs the macOS binaries. This is not optional: a
Bun-compiled arm64 binary has an invalid signature out of the compiler, and
macOS reports that as _"damaged"_ rather than merely untrusted. Set
`APPLE_SIGNING_IDENTITY` (and `APPLE_NOTARY_PROFILE` to notarize) for a real
Developer ID signature — needed only if you distribute outside npm, since
Gatekeeper doesn't quarantine files written by a package manager.

Targets: macOS arm64/x64, Linux arm64/x64 (glibc and musl). No Windows — octomux
is built on tmux and git worktrees, and no `@octomux/tmux-win32-*` exists.
