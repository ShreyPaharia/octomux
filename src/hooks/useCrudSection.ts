import { useCallback, useState } from 'react';

export interface UseCrudSectionOptions<TTarget extends string = string> {
  onCreate?: (value: string) => Promise<void>;
  onDelete?: (target: TTarget) => Promise<void>;
  validateCreate?: (value: string) => boolean;
  initialCreateValue?: string;
}

export function useCrudSection<TTarget extends string = string>({
  onCreate,
  onDelete,
  validateCreate,
  initialCreateValue = '',
}: UseCrudSectionOptions<TTarget> = {}) {
  const [showCreate, setShowCreate] = useState(false);
  const [createValue, setCreateValue] = useState(initialCreateValue);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TTarget | null>(null);
  const [deleting, setDeleting] = useState(false);

  const closeCreate = useCallback(() => {
    setShowCreate(false);
    setCreateValue(initialCreateValue);
  }, [initialCreateValue]);

  const openCreate = useCallback(() => {
    setShowCreate(true);
  }, []);

  const handleCreateOpenChange = useCallback(
    (next: boolean) => {
      if (next) {
        setShowCreate(true);
        return;
      }
      closeCreate();
    },
    [closeCreate],
  );

  const trimmedCreateValue = createValue.trim();
  const canCreate =
    Boolean(trimmedCreateValue) && (!validateCreate || validateCreate(trimmedCreateValue));

  const submitCreate = useCallback(async () => {
    if (!canCreate || creating || !onCreate) return;
    setCreating(true);
    try {
      await onCreate(trimmedCreateValue);
      closeCreate();
    } finally {
      setCreating(false);
    }
  }, [canCreate, creating, onCreate, trimmedCreateValue, closeCreate]);

  const handleDeleteOpenChange = useCallback((next: boolean) => {
    if (!next) setDeleteTarget(null);
  }, []);

  const submitDelete = useCallback(async () => {
    if (!deleteTarget || deleting || !onDelete) return;
    setDeleting(true);
    try {
      await onDelete(deleteTarget);
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, deleting, onDelete]);

  return {
    create: {
      open: showCreate,
      onOpenChange: handleCreateOpenChange,
      value: createValue,
      onChange: setCreateValue,
      creating,
      canSubmit: canCreate,
      openDialog: openCreate,
      closeDialog: closeCreate,
      submit: submitCreate,
    },
    delete: {
      target: deleteTarget,
      setTarget: setDeleteTarget,
      open: deleteTarget !== null,
      onOpenChange: handleDeleteOpenChange,
      deleting,
      submit: submitDelete,
    },
  };
}
