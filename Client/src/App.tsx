import { useState, useEffect } from 'react';
import SearchPage from './pages/SearchPage';
import SettingsPage from './pages/SettingsPage';
import HistoryPage from './pages/HistoryPage';
import { loadSettings, AppSettings } from './lib/store';
import { checkHealth } from './lib/api';

type Page = 'search' | 'history' | 'settings';

export default function App() {
  const [page, setPage] = useState<Page>('search');
  const [settings, setSettings] = useState<AppSettings>({
    serverUrl: '',
    ftpUrl: '',
    ftpPath: '/',
  });
  const [serverOk, setServerOk] = useState<boolean | null>(null);
  const [gameCount, setGameCount] = useState<number | null>(null);

  // Load settings on mount
  useEffect(() => {
    loadSettings().then(setSettings);
  }, []);

  // Health-check when serverUrl changes
  useEffect(() => {
    if (!settings.serverUrl) return;
    setServerOk(null);
    const ctrl = new AbortController();
    checkHealth(settings.serverUrl)
      .then(r => { setServerOk(true); setGameCount(r.games); })
      .catch(() => { setServerOk(false); setGameCount(null); });
    return () => ctrl.abort();
  }, [settings.serverUrl]);

  const handleSettingsSave = (s: AppSettings) => {
    setSettings(s);
  };

  const navItems: { id: Page; icon: string; label: string }[] = [
    { id: 'search',   icon: '🔍', label: '搜索游戏' },
    { id: 'history',  icon: '📋', label: '安装历史' },
    { id: 'settings', icon: '⚙️',  label: '设置' },
  ];

  return (
    <div className="layout">
      {/* Topbar */}
      <header className="topbar">
        <div className="topbar-logo">
          <div className="topbar-logo-icon">🎮</div>
          Switch Game Manager
        </div>
        <div className="topbar-server-status">
          {settings.serverUrl ? (
            <>
              <span
                className={`status-dot ${serverOk === true ? 'ok' : serverOk === false ? 'err' : ''}`}
              />
              {serverOk === null
                ? '连接中…'
                : serverOk
                ? `服务器正常 · ${gameCount ?? '?'} 个游戏`
                : '服务器离线'}
            </>
          ) : (
            <>
              <span className="status-dot" />
              未配置服务器
            </>
          )}
        </div>
      </header>

      {/* Sidebar */}
      <nav className="sidebar">
        {navItems.map(item => (
          <button
            key={item.id}
            id={`nav-${item.id}`}
            className={`nav-item ${page === item.id ? 'active' : ''}`}
            onClick={() => setPage(item.id)}
          >
            <span className="nav-item-icon">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>

      {/* Main */}
      <main className="main">
        {page === 'search' && (
          <SearchPage settings={settings} />
        )}
        {page === 'history' && (
          <HistoryPage settings={settings} />
        )}
        {page === 'settings' && (
          <SettingsPage settings={settings} onSave={handleSettingsSave} />
        )}
      </main>
    </div>
  );
}
