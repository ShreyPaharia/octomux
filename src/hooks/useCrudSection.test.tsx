import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useCrudSection } from './useCrudSection';

describe('useCrudSection', () => {
  it('opens and closes create dialog', () => {
    const { result } = renderHook(() => useCrudSection());
    act(() => result.current.create.openDialog());
    expect(result.current.create.open).toBe(true);
    act(() => result.current.create.onOpenChange(false));
    expect(result.current.create.open).toBe(false);
  });

  it('submits create and closes on success', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useCrudSection({ onCreate }));

    act(() => {
      result.current.create.openDialog();
      result.current.create.onChange('agent-one');
    });

    await act(async () => {
      await result.current.create.submit();
    });

    expect(onCreate).toHaveBeenCalledWith('agent-one');
    expect(result.current.create.open).toBe(false);
    expect(result.current.create.value).toBe('');
  });

  it('does not submit create when value is blank', async () => {
    const onCreate = vi.fn();
    const { result } = renderHook(() => useCrudSection({ onCreate }));

    act(() => result.current.create.openDialog());
    await act(async () => {
      await result.current.create.submit();
    });

    expect(onCreate).not.toHaveBeenCalled();
  });

  it('submits delete and clears target on success', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useCrudSection({ onDelete }));

    act(() => result.current.delete.setTarget('skill-a'));
    expect(result.current.delete.open).toBe(true);

    await act(async () => {
      await result.current.delete.submit();
    });

    expect(onDelete).toHaveBeenCalledWith('skill-a');
    expect(result.current.delete.open).toBe(false);
  });

  it('tracks creating and deleting flags', async () => {
    let resolveCreate!: () => void;
    const onCreate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const { result } = renderHook(() => useCrudSection({ onCreate }));

    act(() => {
      result.current.create.onChange('x');
    });

    act(() => {
      void result.current.create.submit();
    });
    await waitFor(() => expect(result.current.create.creating).toBe(true));

    await act(async () => {
      resolveCreate();
    });
    await waitFor(() => expect(result.current.create.creating).toBe(false));
  });
});
