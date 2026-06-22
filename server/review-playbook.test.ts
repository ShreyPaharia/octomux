import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readPlaybook, appendPlaybookNote, playbookDir } from './review-playbook.js';

let tmpHome: string;
let origHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-pb-'));
  origHome = process.env.HOME;
  process.env.HOME = tmpHome;
});
afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('review-playbook', () => {
  it('returns empty playbook when none exists', () => {
    expect(readPlaybook('/repos/foo')).toEqual({ index: null, files: [] });
  });

  it('appendPlaybookNote creates topic file + INDEX link, readPlaybook returns them', () => {
    appendPlaybookNote('/repos/foo', 'hot-spots', 'auth/token.ts is fragile');
    const pb = readPlaybook('/repos/foo');
    expect(pb.index).toContain('hot-spots.md');
    expect(pb.files).toHaveLength(1);
    expect(pb.files[0]).toMatchObject({ slug: 'hot-spots' });
    expect(pb.files[0].body).toContain('auth/token.ts is fragile');
  });

  it('appending a second note to the same topic does not duplicate the INDEX line', () => {
    appendPlaybookNote('/repos/foo', 'hot-spots', 'first');
    appendPlaybookNote('/repos/foo', 'hot-spots', 'second');
    const pb = readPlaybook('/repos/foo');
    const occurrences = (pb.index ?? '').split('hot-spots.md').length - 1;
    expect(occurrences).toBe(1);
    expect(pb.files[0].body).toContain('first');
    expect(pb.files[0].body).toContain('second');
  });

  it('playbookDir is keyed by repo short name', () => {
    expect(playbookDir('/repos/My Repo')).toContain(path.join('review-playbook', 'my-repo'));
  });
});
