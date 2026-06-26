import { useState, useEffect } from 'react';
import { AppSettings } from '../lib/store';
import { getInstallHistory, InstallRecord } from '../lib/api';

interface Props { settings: AppSettings; }

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function formatStatus(status: string) {
  const map: Record<string, string> = {
    completed: '已完成',
    failed: '失败',
    running: '安装中',
    queued: '排队中',
    retrying: '重试中',
    pending: '等待中',
  };
  return map[status] ?? status;
}

export default function HistoryPage({ settings }: Props) {
  const [records, setRecords] = useState<InstallRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchHistory = async () => {
    if (!settings.serverUrl) return;
    setLoading(true);
    setError('');
    try {
      const res = await getInstallHistory(settings.serverUrl, 100);
      setRecords(res.history);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchHistory(); }, [settings.serverUrl]);

  if (!settings.serverUrl) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">🔌</div>
        <div className="empty-state-title">未配置服务器</div>
        <div className="empty-state-desc">请先在设置页配置服务器地址</div>
      </div>
    );
  }

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 className="page-title" style={{ marginBottom: 0 }}>安装历史</h1>
        <button id="btn-refresh-history" className="btn btn-ghost" onClick={fetchHistory} disabled={loading}>
          {loading ? <><span className="spinner" />刷新中</> : '↻ 刷新'}
        </button>
      </div>

      {error && <div className="alert alert-error">✗ {error}</div>}

      {loading && records.length === 0 && (
        <div className="loading-row"><span className="spinner" /> 加载中…</div>
      )}

      {!loading && records.length === 0 && !error && (
        <div className="empty-state">
          <div className="empty-state-icon">📋</div>
          <div className="empty-state-title">暂无安装记录</div>
          <div className="empty-state-desc">服务器端的 FTP 安装历史将在此显示</div>
        </div>
      )}

      <div className="history-list">
        {records.map(r => (
          <div key={r.id} className="history-item">
            <div className="history-info">
              <div className="history-title">{r.folderName || `游戏 #${r.gameId}`}</div>
              <div className="history-ftp">{r.ftpUrl}{r.targetPath !== '/' ? r.targetPath : ''}</div>
              {r.message && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{r.message}</div>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
              <span className={`status-pill ${r.status}`}>{formatStatus(r.status)}</span>
              <span className="history-time">{formatDate(r.createdAt)}</span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
