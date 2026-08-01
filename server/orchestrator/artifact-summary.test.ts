/**
 * Tests for buildArtifactSummary — the pure gist builder that makes gateway
 * chat replies self-contained instead of bare links.
 */
import { describe, it, expect } from 'vitest';
import { buildArtifactSummary } from './artifact-summary.js';

const PLAN = JSON.stringify({
  schema_version: '1.0.0',
  summary: 'Add a widget and wire it up.',
  files: [
    { path: 'src/widget.ts', action: 'create' },
    { path: 'src/app.ts', action: 'modify' },
  ],
  open_questions: ['Should the widget be lazy-loaded?'],
});

describe('buildArtifactSummary', () => {
  it('renders plan.json summary + file list + open questions', () => {
    const out = buildArtifactSummary('plan.json', PLAN);
    expect(out).toContain('Add a widget and wire it up.');
    expect(out).toContain('src/widget.ts — create');
    expect(out).toContain('src/app.ts — modify');
    expect(out).toContain('Should the widget be lazy-loaded?');
    // Payload is content, not a URL.
    expect(out).not.toMatch(/https?:\/\//);
  });

  it('returns the head of markdown content for spec.md', () => {
    const spec = '# Spec\n\nGoal: make it work.\n\nDetails follow.';
    const out = buildArtifactSummary('spec.md', spec);
    expect(out).toContain('Goal: make it work.');
  });

  it('falls back to raw head when plan.json is malformed', () => {
    const out = buildArtifactSummary('plan.json', '{not valid json');
    expect(out).toContain('{not valid json');
  });

  it('falls back to raw head when plan.json has no recognizable fields', () => {
    const out = buildArtifactSummary('plan.json', JSON.stringify({ nope: 1 }));
    expect(out).toContain('"nope"');
  });

  it('bounds output to maxChars with an ellipsis', () => {
    const long = 'x'.repeat(5000);
    const out = buildArtifactSummary('spec.md', long, 100);
    expect(out.length).toBeLessThanOrEqual(102); // 100 + '\n…'
    expect(out.endsWith('…')).toBe(true);
  });
});
