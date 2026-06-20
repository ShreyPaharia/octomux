export const meta = {
  name: 'review-deep',
  description:
    'Deterministic deep-review engine: parallel lenses -> adversarial verify -> code-enforced threshold/caps/composition. Returns validated findings for the caller to draft.',
  whenToUse:
    'Invoked by the review-deep agent after the walkthrough is ingested. Pass the PR context as args; the workflow returns survivors, the agent drafts them via `octomux review draft-comment`.',
  phases: [
    { title: 'Lenses', detail: 'one reasoning agent per lens, in parallel' },
    { title: 'Verify', detail: 'one adversarial skeptic per candidate finding' },
  ],
};

// args (passed by the invoking agent):
//   { worktree, baseSha, headSha, risk: 'low'|'medium'|'high',
//     keyReviewPoints: string[], groups: object, playbook: string, learnings: {id,why}[] }
const a = args ?? {};
const risk = a.risk ?? 'medium';
const THRESHOLD = risk === 'low' ? 85 : risk === 'high' ? 70 : 75;
const MAX_DRAFTS = 10;

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'line', 'severity', 'kind', 'category', 'body'],
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { enum: ['critical', 'issue', 'suggestion', 'nit'] },
          kind: { enum: ['comment', 'suggestion'] },
          // category drives the composition guard: only test_gap + nit are "low value"
          category: {
            enum: [
              'bug',
              'concurrency',
              'dead_abstraction',
              'architecture',
              'error_handling',
              'test_gap',
              'nit',
            ],
          },
          body: { type: 'string' },
        },
      },
    },
  },
};

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'confidence', 'rationale'],
  properties: {
    verdict: { enum: ['confirmed', 'refuted', 'uncertain'] },
    confidence: { type: 'integer', minimum: 0, maximum: 100 },
    rationale: { type: 'string' },
  },
};

// Lens prompts. The analytical lenses (bug/dead-abstraction/error) reason about
// behaviour and trace data flow across files — not syntax or formatting.
const LENSES = [
  {
    key: 'instruction',
    prompt:
      'Check the diff against CLAUDE.md / AGENTS.md / REVIEW.md within their scope. Report only real violations of stated rules.',
  },
  {
    key: 'behaviour-concurrency',
    prompt:
      'Reason about RUNTIME BEHAVIOUR, not syntax. For every changed loop ask: does a call inside it block? how long? is it on a hot path? Flag serial sync RPC/IO in loops that should fan out, races, lock ordering, leaks, off-by-one, mishandled error/edge state. Category: bug or concurrency.',
  },
  {
    key: 'dead-abstraction',
    prompt:
      'Trace data flow across files. Flag: a map/param/field that is ALWAYS one value (dead abstraction to delete); a value recomputed when already stored/derived upstream; a partial fork of a shared helper that will drift; an encode-then-reparse round-trip; a per-type/per-venue hardcode that should be derived from one source of truth. Category: dead_abstraction or architecture. NOT whitespace/naming/imports.',
  },
  {
    key: 'error-handling',
    prompt:
      'Flag swallowed errors, missing status checks, unhandled rejections, missing catch branches. Category: error_handling.',
  },
  {
    key: 'test-coverage',
    prompt:
      'Flag a test gap ONLY for non-trivial, high-risk untested behaviour (new state machine, idempotency guard, cold-start/reconcile path). NEVER generic "X has no test". Return AT MOST 2 findings. Category: test_gap.',
  },
];

phase('Lenses');
// IMPORTANT: agents run in their own cwd, NOT the review worktree. Every git/read
// MUST be scoped to the worktree explicitly, or the lens reviews the wrong repo.
const wt = a.worktree;
// Diff scope: the stored baseSha can predate the whole upstream stack (huge,
// noisy diff). Diff against the CURRENT base branch's merge-base so the lens
// sees only this PR's own changes — exactly what GitHub shows the human.
const diffCmd = a.baseBranch
  ? `git -C ${wt} fetch origin ${a.baseBranch} --quiet && git -C ${wt} diff $(git -C ${wt} merge-base origin/${a.baseBranch} ${a.headSha})..${a.headSha}`
  : `git -C ${wt} diff ${a.baseSha}..${a.headSha}`;
const diffCtx = `Review worktree: ${wt} — ALL git and file reads MUST target it. Get this PR's diff with:\n  ${diffCmd}\nThen read changed files at absolute paths under ${wt}/. Do NOT run bare \`git\` (your cwd is a DIFFERENT repo — always pass \`-C ${wt}\`). Use reasoning; read changed functions and follow changed symbols into the files that define/consume them (\`git -C ${wt} ...\`). Walkthrough key points: ${JSON.stringify(a.keyReviewPoints ?? [])}. Project playbook (orientation, not findings): ${a.playbook ?? '(none)'}. Learnings — do NOT flag these intentional patterns: ${JSON.stringify(a.learnings ?? [])}.`;

const lensResults = await parallel(
  LENSES.map(
    (l) => () =>
      // Reasoning agents (default), NOT locators — the analytical lenses must
      // read changed functions and trace data flow, not just grep for matches.
      agent(
        `You are the "${l.key}" review lens (read-only, no mutations).\n${l.prompt}\n\n${diffCtx}`,
        {
          label: `lens:${l.key}`,
          phase: 'Lenses',
          schema: FINDINGS_SCHEMA,
        },
      ).then((r) => (r?.findings ?? []).map((f) => ({ ...f, lens: l.key }))),
  ),
);
const candidates = lensResults.filter(Boolean).flat();
log(`${candidates.length} candidate findings from ${LENSES.length} lenses`);

// Stage B — adversarial verify (pipeline: each candidate verified as soon as it's ready)
const verified = await pipeline(candidates, (f) =>
  agent(
    `Verify this review finding against the actual code (read it via \`git -C ${wt} ...\` / files under ${wt}/).\n` +
      `Finding [${f.category}/${f.severity}] ${f.file}:${f.line}: ${f.body}\n${diffCtx}\n` +
      `REFUTE outright (verdict=refuted) only if: a formatter/linter/compiler catches it (gofmt/whitespace, unused import, magic-string, type error); it is pre-existing at base or on an unmodified line; it is already handled nearby; or a learning says it's intentional. ` +
      `For test_gap: refute unless a concrete failure mode goes undetected without the test. ` +
      `For a behaviour/correctness/concurrency/architecture claim: refute ONLY with a concrete reason you traced in the code — "I'm not sure" is NOT grounds to refute; mark it verdict=uncertain instead. A plausible real bug must survive for the author to judge.`,
    { label: `verify:${f.file}:${f.line}`, phase: 'Verify', schema: VERDICT_SCHEMA },
  ).then((v) => ({
    ...f,
    verdict: v?.verdict,
    confidence: v?.confidence ?? 0,
    rationale: v?.rationale,
  })),
);

// Stage C — code-enforced threshold + caps + composition guard.
// Category-aware bar: substantive findings (bugs/concurrency/dead-abstraction/
// architecture/error-handling) survive at a lower confidence so a plausible real
// bug reaches the author; test-gaps and nits must clear the high risk-threshold.
const SUBSTANTIVE = new Set([
  'bug',
  'concurrency',
  'dead_abstraction',
  'architecture',
  'error_handling',
]);
const SUBSTANTIVE_FLOOR = 55;
let survivors = verified
  .filter(Boolean)
  .filter((f) => f.verdict !== 'refuted')
  .filter((f) => f.confidence >= (SUBSTANTIVE.has(f.category) ? SUBSTANTIVE_FLOOR : THRESHOLD))
  .sort((x, y) => y.confidence - x.confidence);

const isLowValue = (f) => f.category === 'test_gap' || f.severity === 'nit';
// Composition guard: low-value (test-gap + nit) findings may be at most 1/3 of drafts.
const high = survivors.filter((f) => !isLowValue(f));
const low = survivors.filter(isLowValue);
const lowAllowed = Math.floor(high.length / 2); // low <= 1/3 of total  <=>  low <= high/2
const keptLow = low.slice(0, lowAllowed);
survivors = [...high, ...keptLow].sort((x, y) => y.confidence - x.confidence);

const droppedByCap = Math.max(0, survivors.length - MAX_DRAFTS);
survivors = survivors.slice(0, MAX_DRAFTS);

log(
  `survivors=${survivors.length} (high-value=${high.length}, low-value kept=${keptLow.length}/${low.length}), ` +
    `risk=${risk} threshold=${THRESHOLD}, droppedByCap=${droppedByCap}`,
);

return {
  threshold: THRESHOLD,
  risk,
  counts: {
    candidates: candidates.length,
    survivors: survivors.length,
    lowValueDropped: low.length - keptLow.length,
    droppedByCap,
  },
  // The caller drafts these via `octomux review draft-comment` (file/line/side new/severity/kind/body).
  findings: survivors.map((f) => ({
    file: f.file,
    line: f.line,
    severity: f.severity,
    kind: f.kind,
    category: f.category,
    lens: f.lens,
    confidence: f.confidence,
    body: f.body,
  })),
};
