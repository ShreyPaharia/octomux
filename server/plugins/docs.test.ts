/**
 * Doc-drift guard for the plugin API (SHR-274).
 *
 * `docs/plugins/` is the only path a third party has to a working plugin: they
 * cannot read `PluginContext` off a published `.d.ts` and infer that the
 * manifest needs a `grants:` key, because the grant model lives in the host,
 * not in the types. So the failure mode is silent and total — the docs stay
 * plausible while the API moves, and every reader who follows them exactly
 * gets a load failure the docs never mentioned. That is precisely what
 * happened before this ticket: `grants` appeared zero times in either file.
 *
 * These are the three claims worth pinning, each derived from source rather
 * than restated:
 *
 * 1. Every `PluginContext` member has a section in the API reference. Driven
 *    off the real interface, so adding a `ctx.foo` to `@octomux/plugin-api`
 *    fails here until it is documented.
 * 2. Every `PluginCapability` name appears verbatim in both docs, and the
 *    exact wording of `assertGranted`'s error does too — the error is the
 *    author's first contact with grants, and a doc quoting a stale version of
 *    it is worse than one quoting none.
 * 3. Every manifest row shown to a reader declares `grants:`. A copy-pasteable
 *    row without it is a guaranteed first-run failure, so this covers the
 *    guide and all three example plugins.
 *
 * Deliberately NOT a prose linter: nothing here checks that a section says
 * anything useful, only that it exists and that the machine-checkable facts in
 * it match the code.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from '../bun-test.js';
import { PLUGIN_CAPABILITIES, assertGranted } from './grants.js';

const repoRoot = path.resolve(import.meta.dir, '../..');
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf-8');

const API_REFERENCE = 'docs/plugins/api-reference.md';
const GUIDE = 'docs/plugins/README.md';

const apiReference = read(API_REFERENCE);
const guide = read(GUIDE);

/** Every example plugin's `README.md`, discovered rather than listed — a new
 *  example must not be able to opt out of the manifest-row check by simply not
 *  being named here. */
function exampleReadmes(): string[] {
  const dir = path.join(repoRoot, 'docs/plugins/examples');
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `docs/plugins/examples/${e.name}/README.md`)
    .filter((rel) => fs.existsSync(path.join(repoRoot, rel)));
}

/**
 * The members of `PluginContext`, parsed out of the pinned types. `id` is
 * excluded: it is the manifest row's bare id, covered under §Namespacing, and
 * has no behaviour of its own to document.
 */
function pluginContextMembers(): string[] {
  const source = read('packages/plugin-api/src/index.ts');
  const body = source.match(/export interface PluginContext \{\n([\s\S]*?)\n\}/);
  if (!body) throw new Error('could not locate `interface PluginContext` in @octomux/plugin-api');
  const members: string[] = [];
  for (const line of body[1].split('\n')) {
    // `readonly records: RecordsRegistrar;` and `effect(dispose: …): void;` —
    // the two shapes the interface actually uses. JSDoc lines start with `*`
    // and match neither.
    const member = line.match(/^\s*(?:readonly\s+)?(\w+)\s*[:(]/);
    if (member && member[1] !== 'id') members.push(member[1]);
  }
  return members;
}

/** Fenced yaml blocks that show a manifest row (`- id:`). */
function manifestYamlBlocks(markdown: string): string[] {
  return (markdown.match(/```ya?ml\n[\s\S]*?```/g) ?? []).filter((block) =>
    /^\s*-\s+id:/m.test(block),
  );
}

/** Whitespace-insensitive containment — prettier reflows prose, and a quoted
 *  error is allowed to wrap. */
function mentions(haystack: string, needle: string): boolean {
  const flatten = (s: string) => s.replace(/\s+/g, ' ').trim();
  return flatten(haystack).includes(flatten(needle));
}

describe('plugin docs', () => {
  it('documents every PluginContext member in the API reference', () => {
    const headings = apiReference.split('\n').filter((line) => /^#{2,4} /.test(line));
    const undocumented = pluginContextMembers().filter(
      (member) => !headings.some((h) => h.includes(`ctx.${member}`)),
    );
    expect(undocumented).toEqual([]);
  });

  it.each([
    [API_REFERENCE, apiReference],
    [GUIDE, guide],
  ])('names every capability grant in %s', (_file, markdown) => {
    const missing = PLUGIN_CAPABILITIES.filter((cap) => !markdown.includes(cap));
    expect(missing).toEqual([]);
  });

  it.each([
    [API_REFERENCE, apiReference],
    [GUIDE, guide],
  ])("quotes assertGranted's current wording in %s", (_file, markdown) => {
    let message = '';
    try {
      assertGranted('never-registered-plugin', 'workflows.register');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toBe('');
    // The plugin id and capability vary per doc example; the sentence that
    // tells the reader what to do does not.
    const invariant = message.slice(message.indexOf('is not granted'), message.indexOf('\n'));
    expect(invariant.length).toBeGreaterThan(0);
    expect(mentions(markdown, invariant)).toBe(true);
  });

  it.each([GUIDE, ...exampleReadmes()])('shows only loadable manifest rows in %s', (rel) => {
    const blocks = manifestYamlBlocks(read(rel));
    expect(blocks.length).toBeGreaterThan(0);
    const ungranted = blocks.filter((block) => !/^\s*grants:/m.test(block));
    expect(ungranted).toEqual([]);
  });

  it('documents the grants key on PluginRow', () => {
    expect(apiReference).toMatch(/grants\?:/);
  });
});
