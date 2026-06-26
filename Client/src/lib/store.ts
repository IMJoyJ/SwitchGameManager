import { load, Store } from '@tauri-apps/plugin-store';

export interface AppSettings {
  serverUrl: string;
  ftpUrl: string;
  ftpPath: string;
}

const DEFAULT_SETTINGS: AppSettings = {
  serverUrl: 'http://192.168.1.100:18080',
  ftpUrl: '',
  ftpPath: '/',
};

let _store: Store | null = null;

async function getStore(): Promise<Store> {
  if (!_store) {
    _store = await load('settings.json');
  }
  return _store;
}

export async function loadSettings(): Promise<AppSettings> {
  const store = await getStore();
  const serverUrl = await store.get<string>('serverUrl') ?? DEFAULT_SETTINGS.serverUrl;
  const ftpUrl = await store.get<string>('ftpUrl') ?? DEFAULT_SETTINGS.ftpUrl;
  const ftpPath = await store.get<string>('ftpPath') ?? DEFAULT_SETTINGS.ftpPath;
  return { serverUrl, ftpUrl, ftpPath };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const store = await getStore();
  await store.set('serverUrl', settings.serverUrl);
  await store.set('ftpUrl', settings.ftpUrl);
  await store.set('ftpPath', settings.ftpPath);
  await store.save();
}
