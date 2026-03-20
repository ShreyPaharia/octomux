import { useState, useEffect } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import type { Task } from '../../../server/types';

interface TaskPickerFieldProps {
  value: string; // task ID
  onChange: (value: string) => void;
}

const ALLOWED_STATUSES = new Set(['running', 'closed']);

export function TaskPickerField({ value, onChange }: TaskPickerFieldProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    api
      .listTasks()
      .then((all) => setTasks(all.filter((t) => ALLOWED_STATUSES.has(t.status))))
      .catch(() => setTasks([]))
      .finally(() => setLoading(false));
  }, []);

  const filtered = tasks.filter((t) => t.title.toLowerCase().includes(search.toLowerCase()));
  const selected = tasks.find((t) => t.id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
          >
            <span className={selected ? '' : 'text-muted-foreground'}>
              {selected ? selected.title : 'Select task...'}
            </span>
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
              className="ml-2 shrink-0 text-muted-foreground"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        }
      />
      <PopoverContent align="start" side="bottom" sideOffset={4} className="w-[var(--popover-trigger-width)] p-0">
        <div className="flex flex-col">
          <div className="p-2 border-b border-border">
            <Input
              placeholder="Search tasks..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
          <div className="max-h-[220px] overflow-y-auto">
            {loading && (
              <div className="px-3 py-4 text-center text-sm text-muted-foreground">Loading...</div>
            )}
            {!loading && filtered.length === 0 && (
              <div className="px-3 py-4 text-center text-sm text-muted-foreground">
                No tasks found
              </div>
            )}
            {!loading &&
              filtered.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-muted transition-colors"
                  onClick={() => {
                    onChange(task.id);
                    setOpen(false);
                  }}
                >
                  <span className="text-sm font-semibold">{task.title}</span>
                  <span className="text-xs text-muted-foreground">{task.id.slice(0, 6)}</span>
                </button>
              ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
