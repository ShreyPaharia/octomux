const STORAGE_KEY = 'octomux-notifications-enabled';

export function getNotificationsEnabled(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== 'false';
}

export function setNotificationsEnabled(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY, String(enabled));
}
