import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AppSettings } from '../lib/store';
import { Game, GameFile } from '../lib/api';

interface Props {
  game: Game;
  settings: AppSettings;
  onClose: () => void;
}

interface ProgressEvent {
  game_id: number;
  file_name: string;
  downloaded: number;
  total: number;
  percent: number;
  speed_bps: number;
  status: string;
  message: string;
}

interface FileInstallState {
  percent: number;
  downloaded: number;
  total: number;
  status: 'idle' | 'running' | 'done' | 'error';
  message: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function isInstallable(file: GameFile): boolean {
  return ['nsp', 'nsz', 'xci', 'xcz'].includes(file.extension?.toLowerCase() ?? '');
}

export default function GameDetail({ game, settings, onClose }: Props) {
  const installableFiles = game.files.filter(isInstallable);
  const [fileStates, setFileStates] = useState<Record<string, FileInstallState>>({});
  const [installError, setInstallError] = useState('');

  // Listen to Rust progress events
  useEffect(() => {
    const unlisten = listen<ProgressEvent>('install_progress', e => {
      const p = e.payload;
      if (p.game_id !== game.id) return;
      setFileStates(prev => ({
        ...prev,
        [p.file_name]: {
          percent: p.percent,
          downloaded: p.downloaded,
          total: p.total,
          status: p.status as FileInstallState['status'],
          message: p.message,
        },
      }));
    });
    return () => { unlisten.then(fn => fn()); };
  }, [game.id]);

  const handleInstall = async (file: GameFile) => {
    // Guard: FTP must be configured
    if (!settings.ftpUrl) {
      setInstallError('请先在设置页配置 Switch FTP 地址，再安装游戏');
      return;
    }
    if (!settings.serverUrl) {
      setInstallError('请先配置服务器地址');
      return;
    }

    setInstallError('');
    setFileStates(prev => ({
      ...prev,
      [file.fileName]: { percent: 0, downloaded: 0, total: 0, status: 'running', message: '连接中…' },
    }));

    try {
      await invoke('install_game', {
        params: {
          server_url: settings.serverUrl,
          game_id: game.id,
          file_name: file.fileName,
          ftp_url: settings.ftpUrl,
          ftp_path: settings.ftpPath || '/',
        },
      });
    } catch (e: unknown) {
      setFileStates(prev => ({
        ...prev,
        [file.fileName]: {
          ...(prev[file.fileName] ?? { percent: 0, downloaded: 0, total: 0 }),
          status: 'error',
          message: String(e),
        },
      }));
    }
  };

  const hasInstalling = Object.values(fileStates).some(s => s.status === 'running');

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true">
        {/* Header */}
        <div className="modal-header">
          <div className="modal-cover">
            {game.icon_url ? (
              <img src={game.icon_url} alt={game.title_name || game.folder_name} />
            ) : '🎮'}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="modal-title">{game.title_name || game.folder_name}</div>
            {game.publisher && <div className="modal-publisher">{game.publisher}</div>}
            <div className="modal-meta-row">
              {game.release_date && <span className="tag">📅 {game.release_date}</span>}
              {game.title_id && <span className="tag">{game.title_id}</span>}
              <span className="tag">{game.file_count} 个文件</span>
            </div>
          </div>
          <button
            id="btn-modal-close"
            onClick={onClose}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text-muted)', fontSize: 20, padding: 4,
              alignSelf: 'flex-start',
            }}
          >✕</button>
        </div>

        {/* Body */}
        <div className="modal-body">
          {installError && (
            <div className="alert alert-error" style={{ marginBottom: 14 }}>
              ⚠️ {installError}
            </div>
          )}

          {!settings.ftpUrl && (
            <div className="alert alert-info" style={{ marginBottom: 14 }}>
              💡 尚未配置 FTP 地址。请在设置页配置后再安装游戏。
            </div>
          )}

          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 10 }}>
            可安装文件（NSP / NSZ / XCI / XCZ）
          </div>

          {installableFiles.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>此游戏文件夹中没有可安装的游戏文件。</p>
          ) : (
            <ul className="files-list">
              {installableFiles.map(file => {
                const state = fileStates[file.fileName];
                const isDone = state?.status === 'done';
                const isErr = state?.status === 'error';
                const isRunning = state?.status === 'running';

                return (
                  <li key={file.fileName} className="file-item" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div className="file-name" title={file.fileName}>{file.fileName}</div>
                      <span className="file-ext">{file.extension?.toUpperCase()}</span>
                      <button
                        id={`btn-install-${file.fileName.replace(/[^a-zA-Z0-9]/g, '_')}`}
                        className={`btn ${isDone ? 'btn-ghost' : 'btn-primary'}`}
                        style={{ fontSize: 12, padding: '6px 12px' }}
                        disabled={isRunning || hasInstalling || !settings.ftpUrl}
                        onClick={() => handleInstall(file)}
                      >
                        {isDone ? '✓ 完成' : isErr ? '重试' : isRunning ? '安装中…' : '安装到 Switch'}
                      </button>
                    </div>

                    {/* Progress bar */}
                    {state && state.status !== 'idle' && (
                      <div className="progress-section">
                        <div className="progress-label">
                          <span>
                            {isErr ? (
                              <span style={{ color: 'var(--red)' }}>✗ {state.message}</span>
                            ) : isDone ? (
                              <span style={{ color: 'var(--green)' }}>✓ 传输完成</span>
                            ) : (
                              state.message
                            )}
                          </span>
                          <span>
                            {state.total > 0
                              ? `${formatBytes(state.downloaded)} / ${formatBytes(state.total)}`
                              : ''}
                          </span>
                        </div>
                        <div className="progress-bar-track">
                          <div
                            className="progress-bar-fill"
                            style={{
                              width: `${state.percent}%`,
                              background: isErr
                                ? 'var(--red)'
                                : isDone
                                ? 'var(--green)'
                                : undefined,
                            }}
                          />
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {/* Other files (non-installable) */}
          {game.files.filter(f => !isInstallable(f)).length > 0 && (
            <>
              <div className="divider" />
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 10 }}>
                其他文件
              </div>
              <ul className="files-list">
                {game.files.filter(f => !isInstallable(f)).map(file => (
                  <li key={file.fileName} className="file-item">
                    <div className="file-name">{file.fileName}</div>
                    {file.extension && <span className="tag">{file.extension.toUpperCase()}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
