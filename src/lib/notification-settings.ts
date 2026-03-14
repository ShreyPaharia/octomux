const STORAGE_KEY = 'octomux-notifications-enabled';

export type NotificationPermission = 'default' | 'granted' | 'denied';

export function getNotificationsEnabled(): boolean {
  return localStorage.getItem(STORAGE_KEY) === 'true';
}

export function setNotificationsEnabled(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY, String(enabled));
}

export function getBrowserPermission(): NotificationPermission {
  if (!('Notification' in window)) return 'denied';
  return Notification.permission as NotificationPermission;
}

export async function requestPermission(): Promise<NotificationPermission> {
  if (!('Notification' in window)) return 'denied';
  const result = await Notification.requestPermission();
  return result as NotificationPermission;
}

export function sendNotification(
  title: string,
  options?: NotificationOptions & { onClick?: () => void },
): Notification | null {
  if (!('Notification' in window)) return null;
  if (Notification.permission !== 'granted') return null;
  if (!getNotificationsEnabled()) return null;

  const { onClick, ...notifOptions } = options ?? {};
  const notification = new Notification(title, notifOptions);
  if (onClick) {
    notification.onclick = () => {
      window.focus();
      onClick();
      notification.close();
    };
  }
  return notification;
}
