import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NavProvider, useNav } from './nav-context';

// A minimal consumer that surfaces NavProvider state + toggles as DOM, so the
// test can drive the context the same way the sidebar shell does.
function Harness() {
  const { collapsed, toggleCollapsed, collapsedGroups, toggleGroupCollapsed, syncGroupKeys } =
    useNav();
  return (
    <div>
      <span data-testid="collapsed">{String(collapsed)}</span>
      <span data-testid="group">{String(collapsedGroups['/dev/nucleus'] ?? 'unset')}</span>
      <button onClick={toggleCollapsed}>toggle-rail</button>
      <button onClick={() => toggleGroupCollapsed('/dev/nucleus')}>toggle-group</button>
      <button onClick={() => syncGroupKeys(['/dev/nucleus'])}>sync</button>
    </div>
  );
}

function renderProvider() {
  return render(
    <NavProvider>
      <Harness />
    </NavProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe('NavProvider rail collapse', () => {
  it('toggling persists octomux-sidebar-collapsed to localStorage', async () => {
    const user = userEvent.setup();
    renderProvider();
    expect(screen.getByTestId('collapsed')).toHaveTextContent('false');

    await user.click(screen.getByText('toggle-rail'));
    expect(screen.getByTestId('collapsed')).toHaveTextContent('true');
    expect(localStorage.getItem('octomux-sidebar-collapsed')).toBe('true');
  });

  it('rehydrates the rail collapsed flag from localStorage on mount', () => {
    localStorage.setItem('octomux-sidebar-collapsed', 'true');
    renderProvider();
    expect(screen.getByTestId('collapsed')).toHaveTextContent('true');
  });
});

describe('NavProvider group collapse', () => {
  it('toggling a group persists under the octomux:sidebar:collapsed: prefix', async () => {
    const user = userEvent.setup();
    renderProvider();

    await user.click(screen.getByText('toggle-group'));
    expect(screen.getByTestId('group')).toHaveTextContent('true');
    expect(localStorage.getItem('octomux:sidebar:collapsed:/dev/nucleus')).toBe('true');
  });

  it('syncGroupKeys seeds new group keys from persisted localStorage state', () => {
    localStorage.setItem('octomux:sidebar:collapsed:/dev/nucleus', 'true');
    renderProvider();
    // Unknown until synced.
    expect(screen.getByTestId('group')).toHaveTextContent('unset');

    act(() => {
      screen.getByText('sync').click();
    });
    expect(screen.getByTestId('group')).toHaveTextContent('true');
  });
});
