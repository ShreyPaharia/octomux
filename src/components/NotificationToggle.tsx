import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import {
  getNotificationsEnabled,
  setNotificationsEnabled,
  getBrowserPermission,
  requestPermission,
} from '@/lib/notification-settings';

export function NotificationToggle() {
  const [enabled, setEnabled] = useState(getNotificationsEnabled);
  const [permission, setPermission] = useState(getBrowserPermission);

  const toggle = useCallback(async () => {
    if (enabled) {
      setNotificationsEnabled(false);
      setEnabled(false);
      return;
    }

    // Need to request browser permission first
    if (permission !== 'granted') {
      const result = await requestPermission();
      setPermission(result);
      if (result !== 'granted') return;
    }

    setNotificationsEnabled(true);
    setEnabled(true);
  }, [enabled, permission]);

  const isDenied = permission === 'denied' && !enabled;

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      title={
        isDenied
          ? 'Notifications blocked — enable in browser settings'
          : enabled
            ? 'Disable notifications'
            : 'Enable notifications'
      }
      className="relative h-8 w-8"
    >
      {enabled ? (
        <BellIcon className="h-4 w-4" />
      ) : isDenied ? (
        <BellSlashIcon className="h-4 w-4 text-muted-foreground" />
      ) : (
        <BellOffIcon className="h-4 w-4 text-muted-foreground" />
      )}
    </Button>
  );
}

function BellIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
    >
      <path
        fillRule="evenodd"
        d="M5.25 9a6.75 6.75 0 0 1 13.5 0v.75c0 2.123.8 4.057 2.118 5.52a.75.75 0 0 1-.573 1.23H3.705a.75.75 0 0 1-.573-1.23A8.973 8.973 0 0 0 5.25 9.75V9ZM8.159 18.753a.75.75 0 0 1 .932-.514 3.756 3.756 0 0 0 5.818 0 .75.75 0 0 1 1.446.418 5.256 5.256 0 0 1-7.678 0 .75.75 0 0 1-.518-.904Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function BellOffIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      className={className}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0"
      />
    </svg>
  );
}

function BellSlashIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      className={className}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9.143 17.082a24.248 24.248 0 0 0 5.714 0m-5.714 0a3 3 0 1 0 5.714 0M9.143 17.082a23.848 23.848 0 0 1-5.454-1.31A8.967 8.967 0 0 0 6 9.75V9a6 6 0 0 1 .258-1.758M18 9.75V9a5.98 5.98 0 0 0-.258-1.758M2 2l20 20"
      />
    </svg>
  );
}
