export interface GameFile {
  fileName: string;
  filePath: string;
  extension: string;
  sizeBytes?: number;
}

export interface Game {
  id: number;
  folder_name: string;
  folder_path: string;
  file_count: number;
  file_names: string;
  files: GameFile[];
  title_id: string;
  title_name: string;
  publisher: string;
  release_date: string;
  icon_url: string;
  match_status: string;
  match_score: number;
  match_type: string;
}

export interface SearchResult {
  total: number;
  page: number;
  limit: number;
  rows: Game[];
}

export interface Suggestion {
  id: number;
  title: string;
  title_id: string;
  icon_url: string;
  match_status: string;
}

export interface HealthResult {
  status: string;
  games: number;
}

export interface InstallRecord {
  id: number;
  gameId: number;
  ftpUrl: string;
  targetPath: string;
  folderName: string;
  status: string;
  progress: number;
  message: string;
  createdAt: string;
  updatedAt: string;
}

async function apiFetch<T>(serverUrl: string, path: string): Promise<T> {
  const url = `${serverUrl.replace(/\/$/, '')}${path}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export function searchGames(serverUrl: string, q: string, page = 1, limit = 20): Promise<SearchResult> {
  return apiFetch(serverUrl, `/api/search?q=${encodeURIComponent(q)}&page=${page}&limit=${limit}`);
}

export function suggestGames(serverUrl: string, q: string): Promise<{ suggestions: Suggestion[] }> {
  return apiFetch(serverUrl, `/api/search/suggest?q=${encodeURIComponent(q)}&limit=8`);
}

export function getGame(serverUrl: string, id: number): Promise<{ game: Game }> {
  return apiFetch(serverUrl, `/api/games/${id}`);
}

export function checkHealth(serverUrl: string): Promise<HealthResult> {
  return apiFetch(serverUrl, '/api/health');
}

export function getInstallHistory(serverUrl: string, limit = 50): Promise<{ history: InstallRecord[] }> {
  return apiFetch(serverUrl, `/api/install/history?limit=${limit}`);
}
