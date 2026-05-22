import { useState, type HTMLAttributes } from 'react';

import { AgentPickerField } from './fields/AgentPickerField';
import { BranchPickerField } from './fields/BranchPickerField';
import { RepoPickerField } from './fields/RepoPickerField';
import { HarnessPicker } from './HarnessPicker';
import {
  composerChipAddClass,
  composerChipNeutralClass,
  composerChipPrimaryClass,
  composerChipWarningClass,
  composerWorktreeToggleClass,
} from '@/lib/composer-styles';
import type { ComposerState } from '@/lib/composer-state';
import { cn, repoBasename } from '@/lib/utils';

export interface ComposerChipRowProps {
  state: ComposerState;
  harnessId: string | null;
  disabledByAddAgent: boolean;
  onPickRepo: (repoPath: string) => void;
  onClearRepo: () => void;
  onPickBranch: (branch: string) => void;
  onToggleWorktree: (worktree: boolean) => void;
  onSetExistingPath: (path: string) => void;
  onClearExistingPath: () => void;
  onPickAgent: (agent: string | null) => void;
  onToggleDraft: () => void;
  onHarnessChange: (id: string) => void;
}

export function ComposerChipRow({
  state,
  harnessId,
  disabledByAddAgent,
  onPickRepo,
  onClearRepo,
  onPickBranch,
  onToggleWorktree,
  onSetExistingPath,
  onClearExistingPath,
  onPickAgent,
  onToggleDraft,
  onHarnessChange,
}: ComposerChipRowProps) {
  const hasRepo = state.mode === 'new' || state.mode === 'none' || state.mode === 'existing';
  const worktreeOn = state.mode === 'new';
  const showBranchChip = state.mode === 'new' || state.mode === 'none';
  const showWorktreeCheckbox = state.mode === 'new' || state.mode === 'none';
  const showAttachChip = state.mode === 'new' || state.mode === 'existing' || state.mode === 'none';
  const showScratchHint = !hasRepo && state.mode !== 'add-agent';
  const pickedAgent = 'agent' in state ? (state.agent ?? null) : null;
  const showAgentChip = state.mode !== 'empty';

  return (
    <div
      className={cn(
        'composer-toolbar flex flex-wrap items-center gap-2',
        disabledByAddAgent && 'pointer-events-none opacity-40',
      )}
      data-testid="chip-row"
    >
      {!hasRepo ? (
        <RepoChip value="" onChange={onPickRepo} onClear={onClearRepo} />
      ) : (
        <RepoChip
          value={
            state.mode === 'new' || state.mode === 'none' || state.mode === 'existing'
              ? state.repo
              : ''
          }
          onChange={onPickRepo}
          onClear={onClearRepo}
        />
      )}

      {showBranchChip && (
        <BranchChip
          repoPath={state.mode === 'new' || state.mode === 'none' ? state.repo : ''}
          value={state.branch ?? ''}
          onChange={onPickBranch}
        />
      )}

      {showWorktreeCheckbox && (
        <WorktreeCheckbox checked={worktreeOn} onChange={onToggleWorktree} />
      )}

      {showAttachChip && (
        <AttachChip
          value={state.mode === 'existing' ? state.worktreePath : ''}
          onChange={onSetExistingPath}
          onClear={onClearExistingPath}
        />
      )}

      {showAgentChip && <AgentChip value={pickedAgent} onChange={onPickAgent} />}

      {state.mode !== 'add-agent' && <HarnessChip value={harnessId} onChange={onHarnessChange} />}

      <DraftToggle
        checked={'isDraft' in state ? state.isDraft : false}
        onChange={onToggleDraft}
        disabled={state.mode === 'empty' || state.mode === 'add-agent'}
      />

      {showScratchHint && (
        <span
          className="ml-auto inline-flex select-none items-center gap-1 rounded-full border border-glass-edge bg-glass-l1/60 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground"
          data-testid="scratch-hint"
          title="No repo selected — submission creates a scratch chat."
        >
          <span className="text-[9px] font-bold opacity-70">S</span>
          <span>scratch</span>
        </span>
      )}
    </div>
  );
}

interface RepoChipProps {
  value: string;
  onChange: (v: string) => void;
  onClear: () => void;
}

function RepoChip({ value, onChange, onClear }: RepoChipProps) {
  const [expanded, setExpanded] = useState(false);
  if (!value && !expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        data-testid="repo-chip-picker"
        className={composerChipAddClass}
      >
        <span aria-hidden>+</span>
        <span>Add repo or folder</span>
      </button>
    );
  }
  if (!value && expanded) {
    return (
      <div className="flex items-center gap-2" data-testid="repo-chip-expanded">
        <div className="w-[320px]">
          <RepoPickerField value="" onChange={onChange} />
        </div>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="text-xs text-muted-foreground"
        >
          cancel
        </button>
      </div>
    );
  }
  return (
    <div data-testid="repo-chip" title={value} className={composerChipPrimaryClass()}>
      <button
        type="button"
        onClick={onClear}
        aria-label="Remove"
        className="inline-flex items-center gap-1.5 font-semibold text-primary hover:opacity-80"
      >
        <span aria-hidden>📁</span>
        <span>{repoBasename(value)}</span>
        <span aria-hidden className="text-primary/70">
          ×
        </span>
      </button>
    </div>
  );
}

interface BranchChipProps {
  repoPath: string;
  value: string;
  onChange: (branch: string) => void;
}

function BranchChip({ repoPath, value, onChange }: BranchChipProps) {
  return (
    <div className={composerChipNeutralClass} data-testid="branch-chip">
      <span className="text-[11px] text-muted-foreground" aria-hidden>
        ⎇
      </span>
      <div className="min-w-[100px] max-w-[220px]">
        <BranchPickerField
          repoPath={repoPath}
          value={value}
          onChange={onChange}
          triggerClassName="focus-ring flex w-full items-center justify-between gap-1.5 bg-transparent font-mono text-[11px] text-[#D0D0D0] outline-none hover:text-white disabled:opacity-60"
        />
      </div>
    </div>
  );
}

interface WorktreeCheckboxProps {
  checked: boolean;
  onChange: (v: boolean) => void;
}

function WorktreeCheckbox({ checked, onChange }: WorktreeCheckboxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label="Create a fresh worktree for this task"
      onClick={() => onChange(!checked)}
      data-testid="worktree-checkbox"
      data-state={checked ? 'checked' : 'unchecked'}
      className={composerWorktreeToggleClass(checked)}
    >
      <span
        aria-hidden
        className={cn(
          'inline-flex size-3.5 items-center justify-center rounded-sm border',
          checked ? 'border-primary/60 bg-primary' : 'border-glass-edge bg-transparent',
        )}
      >
        {checked && (
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="white"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        )}
      </span>
      <span>new worktree</span>
    </button>
  );
}

function AttachChip({
  value,
  onChange,
  onClear,
}: {
  value: string;
  onChange: (path: string) => void;
  onClear: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [typed, setTyped] = useState('');

  if (!value && !expanded) {
    return (
      <ChipButton onClick={() => setExpanded(true)} data-testid="attach-chip-picker">
        <span aria-hidden>🔗</span>
        <span>attach</span>
      </ChipButton>
    );
  }
  if (!value && expanded) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (typed.trim()) {
            onChange(typed.trim());
            setExpanded(false);
            setTyped('');
          }
        }}
        className="flex items-center gap-1"
        data-testid="attach-chip-expanded"
      >
        <span className="text-xs text-muted-foreground">🔗</span>
        <input
          autoFocus
          placeholder="/path/to/existing/worktree"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onBlur={() => {
            if (typed.trim()) onChange(typed.trim());
            setExpanded(false);
          }}
          className="h-7 w-[280px] border border-input bg-transparent px-2 text-xs font-mono outline-none focus:border-ring"
          aria-label="Existing worktree path"
        />
      </form>
    );
  }
  return (
    <ChipRemovable
      label={`🔗 ${repoBasename(value)}`}
      title={value}
      onRemove={onClear}
      data-testid="attach-chip"
    />
  );
}

interface AgentChipProps {
  value: string | null;
  onChange: (agent: string | null) => void;
}

function AgentChip({ value, onChange }: AgentChipProps) {
  if (!value) {
    return (
      <div data-testid="agent-chip-empty">
        <AgentPickerField
          value={null}
          onChange={onChange}
          triggerLabel="+ run as agent"
          triggerClassName={composerChipAddClass}
        />
      </div>
    );
  }
  return (
    <div data-testid="agent-chip" title={value} className={composerChipWarningClass()}>
      <button
        type="button"
        onClick={() => onChange(null)}
        aria-label="Clear agent"
        className="inline-flex items-center gap-1.5 font-semibold text-warning hover:opacity-80"
      >
        <span aria-hidden>🤖</span>
        <span>{value}</span>
        <span aria-hidden className="text-warning/70">
          ×
        </span>
      </button>
    </div>
  );
}

interface HarnessChipProps {
  value: string | null;
  onChange: (id: string) => void;
}

function HarnessChip({ value, onChange }: HarnessChipProps) {
  return (
    <div className={composerChipNeutralClass} data-testid="harness-chip" title="Coding agent">
      <span aria-hidden className="text-[11px] text-muted-foreground">
        ⚙
      </span>
      <div className="min-w-[80px] max-w-[160px]">
        <HarnessPicker
          value={value}
          onChange={onChange}
          triggerClassName="focus-ring flex w-full items-center justify-between gap-1.5 bg-transparent font-mono text-[11px] text-[#D0D0D0] outline-none hover:text-white disabled:opacity-60"
        />
      </div>
    </div>
  );
}

function DraftToggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      disabled={disabled}
      aria-pressed={checked}
      data-testid="draft-toggle"
      className={`focus-ring rounded-full border px-3 py-1 text-[11px] font-mono transition-colors disabled:opacity-40 ${
        checked
          ? 'border-primary/40 bg-primary/10 text-primary'
          : 'border-glass-edge bg-glass-l1/50 text-muted-foreground hover:text-foreground'
      }`}
    >
      📝 draft
    </button>
  );
}

function ChipButton({ children, onClick, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(composerChipAddClass, 'border-solid hover:bg-glass-l2/50')}
      {...rest}
    >
      {children}
    </button>
  );
}

function ChipRemovable({
  label,
  title,
  onRemove,
  ...rest
}: {
  label: string;
  title?: string;
  onRemove: () => void;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} title={title} className={composerChipNeutralClass}>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove"
        className="focus-ring inline-flex items-center gap-1.5 text-foreground hover:text-muted-foreground"
      >
        <span>{label}</span>
        <span className="text-muted-foreground">×</span>
      </button>
    </div>
  );
}
