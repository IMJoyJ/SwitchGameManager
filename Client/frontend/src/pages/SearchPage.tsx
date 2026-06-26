import { useState, useEffect, useRef, useCallback } from 'react';
import { AppSettings } from '../lib/store';
import { searchGames, suggestGames, Game, Suggestion } from '../lib/api';
import GameDetail from '../components/GameDetail';

interface Props { settings: AppSettings; }

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export default function SearchPage({ settings }: Props) {
  const [query, setQuery] = useState('');
  const [games, setGames] = useState<Game[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showSuggest, setShowSuggest] = useState(false);
  const [selectedGame, setSelectedGame] = useState<Game | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debouncedQuery = useDebounce(query, 250);

  const LIMIT = 20;

  // Suggestions
  useEffect(() => {
    if (!debouncedQuery || !settings.serverUrl) { setSuggestions([]); return; }
    suggestGames(settings.serverUrl, debouncedQuery)
      .then(r => setSuggestions(r.suggestions))
      .catch(() => setSuggestions([]));
  }, [debouncedQuery, settings.serverUrl]);

  const doSearch = useCallback(async (q: string, pg: number) => {
    if (!q.trim() || !settings.serverUrl) return;
    setLoading(true);
    setError('');
    setShowSuggest(false);
    try {
      const res = await searchGames(settings.serverUrl, q, pg, LIMIT);
      if (pg === 1) setGames(res.rows);
      else setGames(prev => [...prev, ...res.rows]);
      setTotal(res.total);
      setPage(pg);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [settings.serverUrl]);

  const handleSearch = () => {
    if (!settings.serverUrl) { setError('请先在设置页配置服务器地址'); return; }
    setPage(1);
    setGames([]);
    doSearch(query, 1);
  };

  const handleSuggestClick = (s: Suggestion) => {
    setQuery(s.title);
    setShowSuggest(false);
    setGames([]);
    setPage(1);
    doSearch(s.title, 1);
  };

  const matchBadge = (status: string) => {
    if (status === 'matched') return <span className="badge badge-matched">已匹配</span>;
    if (status === 'fuzzy_matched') return <span className="badge badge-fuzzy">模糊匹配</span>;
    return <span className="badge badge-none">无标题库</span>;
  };

  if (!settings.serverUrl) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">🔌</div>
        <div className="empty-state-title">未配置服务器</div>
        <div className="empty-state-desc">请前往 <strong>设置</strong> 页面配置服务器地址后再使用搜索功能</div>
      </div>
    );
  }

  return (
    <>
      <h1 className="page-title">搜索游戏</h1>

      {/* Search bar */}
      <div className="search-bar-wrap">
        <span className="search-icon">🔍</span>
        <input
          ref={inputRef}
          id="search-input"
          type="text"
          placeholder="输入游戏名称、拼音缩写或 Title ID…"
          value={query}
          onChange={e => { setQuery(e.target.value); setShowSuggest(true); }}
          onFocus={() => setShowSuggest(true)}
          onBlur={() => setTimeout(() => setShowSuggest(false), 150)}
          onKeyDown={e => { if (e.key === 'Enter') handleSearch(); }}
        />
        {showSuggest && suggestions.length > 0 && (
          <div className="suggest-dropdown">
            {suggestions.map(s => (
              <div
                key={s.id}
                className="suggest-item"
                onMouseDown={() => handleSuggestClick(s)}
              >
                {s.icon_url ? (
                  <img className="suggest-thumb" src={s.icon_url} alt="" loading="lazy" />
                ) : (
                  <div className="suggest-thumb-placeholder">🎮</div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="suggest-title">{s.title}</div>
                  {s.title_id && <div className="suggest-title-id">{s.title_id}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <button id="btn-search" className="btn btn-primary" onClick={handleSearch} disabled={loading || !query}>
          {loading && page === 1 ? <><span className="spinner" /> 搜索中…</> : '搜索'}
        </button>
        {games.length > 0 && (
          <span style={{ display: 'flex', alignItems: 'center', fontSize: 13, color: 'var(--text-muted)' }}>
            共 {total} 条结果
          </span>
        )}
      </div>

      {error && <div className="alert alert-error">✗ {error}</div>}

      {/* Results */}
      {games.length > 0 && (
        <>
          <div className="game-grid">
            {games.map(game => (
              <div
                key={game.id}
                className="game-card"
                onClick={() => setSelectedGame(game)}
              >
                <div className="game-card-cover">
                  {game.icon_url ? (
                    <img src={game.icon_url} alt={game.title_name || game.folder_name} loading="lazy" />
                  ) : '🎮'}
                </div>
                <div className="game-card-body">
                  <div className="game-card-title">{game.title_name || game.folder_name}</div>
                  <div className="game-card-meta">
                    <span className="game-card-publisher">{game.publisher || '—'}</span>
                    {matchBadge(game.match_status)}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Load more */}
          {games.length < total && (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 24 }}>
              <button
                id="btn-load-more"
                className="btn btn-ghost"
                disabled={loading}
                onClick={() => doSearch(query, page + 1)}
              >
                {loading ? <><span className="spinner" /> 加载中…</> : '加载更多'}
              </button>
            </div>
          )}
        </>
      )}

      {!loading && games.length === 0 && query && !error && (
        <div className="empty-state">
          <div className="empty-state-icon">🎮</div>
          <div className="empty-state-title">没有找到游戏</div>
          <div className="empty-state-desc">尝试用其他关键字、拼音缩写或 Title ID 搜索</div>
        </div>
      )}

      {/* Game Detail Modal */}
      {selectedGame && (
        <GameDetail
          game={selectedGame}
          settings={settings}
          onClose={() => setSelectedGame(null)}
        />
      )}
    </>
  );
}
