import { useState } from 'react';

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`relative h-5 w-9 transition-colors ${checked ? 'bg-primary' : 'bg-[#2f2f2f]'}`}
      onClick={() => onChange(!checked)}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-4 w-4 bg-white transition-transform ${checked ? 'translate-x-4' : ''}`}
      />
    </button>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <h2 className="mb-4 text-[10px] font-bold uppercase tracking-wider text-[#6a6a6a]">
      // {label}
    </h2>
  );
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between border-b border-[#2f2f2f] py-3">
      <div>
        <span className="text-sm">{label}</span>
        {description && <p className="text-xs text-[#6a6a6a]">{description}</p>}
      </div>
      {children}
    </div>
  );
}

export default function SettingsPage() {
  const [notifications, setNotifications] = useState(
    () => localStorage.getItem('octomux-notifications') !== 'false',
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('octomux-sidebar-collapsed') === 'true',
  );

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-2xl px-6 py-6">
        <h1 className="mb-8 font-display text-2xl font-bold">SETTINGS</h1>

        <section className="mb-8">
          <SectionHeader label="GENERAL" />
          <SettingRow label="Notifications" description="Show toast notifications for task events">
            <ToggleSwitch
              checked={notifications}
              onChange={(v) => {
                setNotifications(v);
                localStorage.setItem('octomux-notifications', String(v));
              }}
            />
          </SettingRow>
          <SettingRow label="Sidebar collapsed by default">
            <ToggleSwitch
              checked={sidebarCollapsed}
              onChange={(v) => {
                setSidebarCollapsed(v);
                localStorage.setItem('octomux-sidebar-collapsed', String(v));
              }}
            />
          </SettingRow>
        </section>

        <section className="mb-8">
          <SectionHeader label="TASK DEFAULTS" />
          <SettingRow
            label="Default base branch"
            description="Branch used as default when creating tasks"
          >
            <span className="text-xs text-[#8a8a8a]">main</span>
          </SettingRow>
        </section>

        <section className="mb-8">
          <SectionHeader label="ORCHESTRATOR" />
          <SettingRow
            label="Auto-start orchestrator"
            description="Start orchestrator when dashboard loads"
          >
            <ToggleSwitch checked={false} onChange={() => {}} />
          </SettingRow>
        </section>
      </div>
    </div>
  );
}
