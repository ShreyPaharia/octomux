import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReviewContextStrip } from './ReviewContextStrip';
import type { RenderGroup } from '@/lib/review-file-groups';

const GROUPS: RenderGroup[] = [
  {
    name: 'Core',
    summary: 'Group-level explanation that should appear in full.',
    files: [{ path: 'src/a.ts', label: 'enhancement', summary: 'File-level explanation.' }],
  },
];

describe('ReviewContextStrip', () => {
  it('prompts when no file is selected', () => {
    render(<ReviewContextStrip groups={GROUPS} selectedPath={null} />);
    expect(screen.getByText(/select a file/i)).toBeTruthy();
  });

  it('shows full group and file notes for selection', () => {
    render(<ReviewContextStrip groups={GROUPS} selectedPath="src/a.ts" />);
    expect(screen.getByText(/Group-level explanation/)).toBeTruthy();
    expect(screen.getByText(/File-level explanation/)).toBeTruthy();
  });
});
