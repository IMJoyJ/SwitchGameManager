import { GetSettings, SaveSettings } from '../wailsjs/go/main/App';

export interface AppSettings {
  serverUrl: string;
  ftpUrl: string;
  ftpPath: string;
}

export async function loadSettings(): Promise<AppSettings> {
  return GetSettings();
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await SaveSettings(settings);
}
