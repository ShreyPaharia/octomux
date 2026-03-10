interface TaskFilterBarProps {
  activeStatus: 'open' | 'closed';
  counts: { open: number; closed: number };
  onStatusChange: (status: 'open' | 'closed') => void;
}

export function TaskFilterBar({ activeStatus, counts, onStatusChange }: TaskFilterBarProps) {
  const tabs = [
    { key: 'open' as const, label: `Open (${counts.open})` },
    { key: 'closed' as const, label: `Closed (${counts.closed})` },
  ];

  return (
    <div className="mb-4 flex gap-1 border-b border-border">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          className={`px-3 py-2 text-sm font-medium ${
            activeStatus === tab.key
              ? 'border-b-2 border-primary text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => onStatusChange(tab.key)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
