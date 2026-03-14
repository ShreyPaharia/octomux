import { describe, it, expect } from 'vitest';
import { groupTasksForSidebar, type SidebarItem, type SidebarGroup } from './sidebar-utils';
import { makeTask } from '@/test-helpers';

describe('groupTasksForSidebar', () => {
  it('excludes draft and closed tasks', () => {
    const tasks = [
      makeTask({ id: '1', status: 'running', title: 'A' }),
      makeTask({ id: '2', status: 'draft', title: 'B' }),
      makeTask({ id: '3', status: 'closed', title: 'C' }),
      makeTask({ id: '4', status: 'error', title: 'D' }),
    ];
    const groups = groupTasksForSidebar(tasks);
    const ids = groups.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toEqual(['1', '4']);
  });

  it('groups by repo basename', () => {
    const tasks = [
      makeTask({ id: '1', status: 'running', repo_path: '/home/dev/repo-a' }),
      makeTask({ id: '2', status: 'running', repo_path: '/home/dev/repo-b' }),
      makeTask({ id: '3', status: 'error', repo_path: '/home/dev/repo-a' }),
    ];
    const groups = groupTasksForSidebar(tasks);
    expect(groups.map((g) => g.repo)).toEqual(['repo-a', 'repo-b']);
    expect(groups[0].items).toHaveLength(2);
    expect(groups[1].items).toHaveLength(1);
  });

  it.each([
    {
      name: 'running before error',
      tasks: [
        makeTask({ id: '1', status: 'error' }),
        makeTask({ id: '2', status: 'running' }),
      ],
      expectedOrder: ['2', '1'],
    },
    {
      name: 'setting_up before error',
      tasks: [
        makeTask({ id: '1', status: 'error' }),
        makeTask({ id: '2', status: 'setting_up' }),
      ],
      expectedOrder: ['2', '1'],
    },
    {
      name: 'running before needs_attention',
      tasks: [
        makeTask({ id: '1', status: 'running', derived_status: 'needs_attention' }),
        makeTask({ id: '2', status: 'running', derived_status: 'working' }),
      ],
      expectedOrder: ['2', '1'],
    },
    {
      name: 'needs_attention before error',
      tasks: [
        makeTask({ id: '1', status: 'error' }),
        makeTask({ id: '2', status: 'running', derived_status: 'needs_attention' }),
      ],
      expectedOrder: ['2', '1'],
    },
  ])('sorts $name', ({ tasks, expectedOrder }) => {
    const groups = groupTasksForSidebar(tasks);
    const ids = groups.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toEqual(expectedOrder);
  });

  it('uses recency as tiebreaker within same priority', () => {
    const tasks = [
      makeTask({ id: '1', status: 'running', created_at: '2026-01-01 00:00:00' }),
      makeTask({ id: '2', status: 'running', created_at: '2026-01-02 00:00:00' }),
    ];
    const groups = groupTasksForSidebar(tasks);
    const ids = groups.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toEqual(['2', '1']); // newer first
  });

  it('returns empty array for no active tasks', () => {
    const tasks = [makeTask({ id: '1', status: 'draft' })];
    expect(groupTasksForSidebar(tasks)).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(groupTasksForSidebar([])).toEqual([]);
  });

  it('extracts only sidebar-relevant fields into SidebarItem', () => {
    const tasks = [
      makeTask({
        id: '1',
        status: 'running',
        title: 'My Task',
        repo_path: '/home/dev/repo',
        derived_status: 'needs_attention',
      }),
    ];
    const groups = groupTasksForSidebar(tasks);
    const item = groups[0].items[0];
    expect(item).toEqual({
      id: '1',
      title: 'My Task',
      status: 'running',
      derivedStatus: 'needs_attention',
    });
  });

  it('sorts groups alphabetically by repo name', () => {
    const tasks = [
      makeTask({ id: '1', status: 'running', repo_path: '/home/dev/zebra' }),
      makeTask({ id: '2', status: 'running', repo_path: '/home/dev/alpha' }),
      makeTask({ id: '3', status: 'running', repo_path: '/home/dev/middle' }),
    ];
    const groups = groupTasksForSidebar(tasks);
    expect(groups.map((g) => g.repo)).toEqual(['alpha', 'middle', 'zebra']);
  });

  // Type-only checks — these ensure the exported types satisfy the expected shape
  it('SidebarItem and SidebarGroup types are exported', () => {
    const item: SidebarItem = {
      id: 'x',
      title: 'T',
      status: 'running',
      derivedStatus: null,
    };
    const group: SidebarGroup = { repo: 'r', items: [item] };
    expect(group.repo).toBe('r');
  });
});
