import { describe, it, expect } from '../bun-test.js';
import { condenseForChat, CHAT_MAX_CHARS } from './condense.js';

const PLAN = {
  schema_version: '1.0.0',
  summary: 'Add a condense guard to the gateway outbound path.',
  files: [
    { path: 'server/gateway/condense.ts', action: 'create', steps: ['write it'] },
    { path: 'server/gateway/gateway.ts', action: 'modify', steps: ['wire it'] },
  ],
  open_questions: ['Should Slack get a higher cap?'],
  detail: 'A very long prose body that must never reach chat. '.repeat(30),
};
const PLAN_JSON = JSON.stringify(PLAN, null, 2);

describe('condenseForChat', () => {
  it.each([
    ['fenced json block', `plan ready — approve?\n\`\`\`json\n${PLAN_JSON}\n\`\`\`\nok?`],
    ['bare fenced block', `plan ready — approve?\n\`\`\`\n${PLAN_JSON}\n\`\`\`\nok?`],
    ['unfenced blob', `plan ready — approve?\n${PLAN_JSON}\nok?`],
  ])('replaces a plan.json payload (%s) with a readable summary', (_name, message) => {
    const out = condenseForChat(message);
    expect(out).toContain('📋 Plan: Add a condense guard to the gateway outbound path.');
    expect(out).toContain('• server/gateway/condense.ts (create)');
    expect(out).toContain('• server/gateway/gateway.ts (modify)');
    expect(out).toContain('Open questions:');
    expect(out).toContain('• Should Slack get a higher cap?');
    // No raw JSON survives: no schema_version key, no steps, no detail body.
    expect(out).not.toContain('schema_version');
    expect(out).not.toContain('"steps"');
    expect(out).not.toContain('must never reach chat');
    // Surrounding prose is preserved.
    expect(out).toContain('plan ready — approve?');
    expect(out).toContain('ok?');
  });

  it('collapses a large non-plan JSON blob to a condensed marker with keys and gist', () => {
    const blob = JSON.stringify({
      title: 'walkthrough of the change',
      sections: Array.from({ length: 20 }, (_, i) => ({ heading: `h${i}`, body: 'x'.repeat(40) })),
    });
    const out = condenseForChat(`here it is:\n${blob}`);
    expect(out).toContain('[structured payload condensed —');
    expect(out).toContain('keys: title, sections');
    expect(out).toContain('walkthrough of the change');
    expect(out).not.toContain('"sections"');
  });

  it.each([
    ['small inline JSON', 'set {"level":"debug"} in the config'],
    ['plain prose', 'Two tasks running; both green. Want a third?'],
    ['prose with braces', 'in TS use `type X = { a: string }` for that'],
    ['unbalanced brace', 'an open { with no close and ' + 'filler '.repeat(80)],
  ])('leaves %s untouched', (_name, message) => {
    expect(condenseForChat(message)).toBe(message);
  });

  it('does not crash or mangle a large unparseable brace span', () => {
    const notJson = `{ this is ${'definitely '.repeat(60)}not json }`;
    expect(condenseForChat(notJson)).toBe(notJson);
  });

  it('truncates an over-long message (e.g. a pasted 19KB spec) with a clear marker', () => {
    const spec = `# Spec\n${'All work and no play makes Jack a dull boy. '.repeat(450)}`;
    expect(spec.length).toBeGreaterThan(19_000);
    const out = condenseForChat(spec);
    expect(out.length).toBeLessThan(CHAT_MAX_CHARS + 50);
    expect(out).toContain(`… [truncated, ${spec.length - CHAT_MAX_CHARS} chars omitted]`);
    expect(out.startsWith('# Spec')).toBe(true);
  });

  it('summarizes a plan even when the surrounding message is huge, then caps length', () => {
    const message = `${PLAN_JSON}\n${'padding '.repeat(1000)}`;
    const out = condenseForChat(message);
    expect(out).toContain('📋 Plan:');
    expect(out.length).toBeLessThan(CHAT_MAX_CHARS + 50);
    expect(out).toContain('… [truncated,');
  });
});
