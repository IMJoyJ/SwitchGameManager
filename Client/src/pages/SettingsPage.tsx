import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AppSettings, saveSettings } from '../lib/store';

interface Props {
  settings: AppSettings;
  onSave: (s: AppSettings) => void;
}

export default function SettingsPage({ settings, onSave }: Props) {
  const [form, setForm] = useState<AppSettings>(settings);
  const [saved, setSaved] = useState(false);
  const [ftpTesting, setFtpTesting] = useState(false);
  const [ftpResult, setFtpResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => { setForm(settings); }, [settings]);

  const handleSave = async () => {
    await saveSettings(form);
    onSave(form);
    setSaved(true);
    setFtpResult(null);
    setTimeout(() => setSaved(false), 2500);
  };

  const handleFtpTest = async () => {
    if (!form.ftpUrl) {
      setFtpResult({ ok: false, message: 'FTP 地址不能为空' });
      return;
    }
    setFtpTesting(true);
    setFtpResult(null);
    try {
      const result = await invoke<{ ok: boolean; message: string }>('preflight_ftp', {
        ftpUrl: form.ftpUrl,
        ftpPath: form.ftpPath || '/',
      });
      setFtpResult(result);
    } catch (e: unknown) {
      setFtpResult({ ok: false, message: String(e) });
    } finally {
      setFtpTesting(false);
    }
  };

  return (
    <>
      <h1 className="page-title">设置</h1>

      {/* Server Settings */}
      <div className="settings-section">
        <div className="settings-section-title">服务器配置</div>
        <div className="card">
          <div className="form-group">
            <label htmlFor="server-url">服务器地址</label>
            <input
              id="server-url"
              type="url"
              placeholder="http://192.168.1.100:18080"
              value={form.serverUrl}
              onChange={e => setForm(f => ({ ...f, serverUrl: e.target.value }))}
            />
            <p className="input-hint">Switch Game Manager 服务端地址（含端口号）</p>
          </div>
        </div>
      </div>

      {/* FTP Settings */}
      <div className="settings-section">
        <div className="settings-section-title">Switch FTP 配置</div>
        <div className="card">
          <div className="form-group">
            <label htmlFor="ftp-url">FTP 地址</label>
            <input
              id="ftp-url"
              type="url"
              placeholder="ftp://192.168.1.50:5000"
              value={form.ftpUrl}
              onChange={e => { setForm(f => ({ ...f, ftpUrl: e.target.value })); setFtpResult(null); }}
            />
            <p className="input-hint">Switch 上 DBI 等软件开启的 FTP 服务地址（可选，安装前必须填写）</p>
          </div>

          <div className="form-group">
            <label htmlFor="ftp-path">安装目标路径</label>
            <input
              id="ftp-path"
              type="text"
              placeholder="/"
              value={form.ftpPath}
              onChange={e => { setForm(f => ({ ...f, ftpPath: e.target.value })); setFtpResult(null); }}
            />
            <p className="input-hint">游戏文件将上传到 FTP 的此路径下</p>
          </div>

          {ftpResult && (
            <div className={`alert ${ftpResult.ok ? 'alert-success' : 'alert-error'}`}>
              {ftpResult.ok ? '✓' : '✗'} {ftpResult.message}
            </div>
          )}

          <button
            id="btn-test-ftp"
            className="btn btn-ghost"
            onClick={handleFtpTest}
            disabled={ftpTesting || !form.ftpUrl}
          >
            {ftpTesting ? <><span className="spinner" /> 测试中…</> : '测试 FTP 连接'}
          </button>
        </div>
      </div>

      {/* Save */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <button id="btn-save-settings" className="btn btn-primary" onClick={handleSave}>
          保存设置
        </button>
        {saved && (
          <span className="save-success">✓ 已保存</span>
        )}
      </div>
    </>
  );
}
