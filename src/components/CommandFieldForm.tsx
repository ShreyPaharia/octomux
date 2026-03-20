import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { RepoPickerField } from '@/components/fields/RepoPickerField';
import type { RepoValidation } from '@/components/fields/RepoPickerField';
import { BranchPickerField } from '@/components/fields/BranchPickerField';
import { TaskPickerField } from '@/components/fields/TaskPickerField';
import type { OrchestratorCommand, CommandField } from '@/lib/orchestrator-commands';

interface CommandFieldFormProps {
  command: OrchestratorCommand;
  onSubmit: (message: string) => void;
  onClose: () => void;
  sending: boolean;
}

export function CommandFieldForm({ command, onSubmit, onClose, sending }: CommandFieldFormProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [_repoValidation, setRepoValidation] = useState<RepoValidation>('idle');

  const setValue = useCallback(
    (name: string, value: string) => {
      setValues((prev) => {
        const next = { ...prev, [name]: value };
        // Reset dependent fields when a field changes
        if (command.fields) {
          for (const field of command.fields) {
            if (field.dependsOn === name) {
              next[field.name] = '';
            }
          }
        }
        return next;
      });
    },
    [command.fields],
  );

  const requiredFieldsFilled =
    !command.fields ||
    command.fields.filter((f) => f.required).every((f) => (values[f.name] || '').trim() !== '');

  const canSubmit = requiredFieldsFilled && !sending;

  const handleSubmit = () => {
    if (!canSubmit) return;
    const message = command.buildMessage(values);
    onSubmit(message);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
      return;
    }
  };

  const handleTextInputKeyDown = (e: React.KeyboardEvent) => {
    handleKeyDown(e);
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const renderField = (field: CommandField) => {
    const value = values[field.name] || '';

    switch (field.type) {
      case 'text':
        return (
          <Input
            value={value}
            onChange={(e) => setValue(field.name, e.target.value)}
            placeholder={field.placeholder}
            onKeyDown={handleTextInputKeyDown}
          />
        );
      case 'textarea':
        return (
          <Textarea
            value={value}
            onChange={(e) => setValue(field.name, e.target.value)}
            placeholder={field.placeholder}
            onKeyDown={handleKeyDown}
            rows={3}
          />
        );
      case 'repo-picker':
        return (
          <RepoPickerField
            value={value}
            onChange={(v) => setValue(field.name, v)}
            onValidationChange={setRepoValidation}
          />
        );
      case 'branch-picker':
        return (
          <BranchPickerField
            repoPath={field.dependsOn ? values[field.dependsOn] || '' : ''}
            value={value}
            onChange={(v) => setValue(field.name, v)}
            disabled={field.dependsOn ? !values[field.dependsOn] : false}
          />
        );
      case 'task-picker':
        return <TaskPickerField value={value} onChange={(v) => setValue(field.name, v)} />;
      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col gap-3 p-3" onKeyDown={handleKeyDown}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">{command.chipLabel}</span>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close" className="h-7">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </Button>
          <Button
            size="sm"
            disabled={!canSubmit}
            onClick={handleSubmit}
            aria-label="Send"
            className="h-7"
          >
            Send
          </Button>
        </div>
      </div>

      {/* Fields */}
      {command.fields?.map((field) => (
        <div key={field.name} className="flex flex-col gap-1.5">
          <Label htmlFor={field.name}>
            {field.label}
            {field.required && <span className="text-destructive ml-0.5">*</span>}
          </Label>
          {renderField(field)}
        </div>
      ))}
    </div>
  );
}
