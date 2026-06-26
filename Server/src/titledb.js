'use strict';

const fs = require('fs');
const path = require('path');
const { pinyin } = require('pinyin');
const levenshtein = require('fast-levenshtein');
const config = require('./config');

const TITLE_ID_PATTERN = /[0-9a-fA-F]{16}/g;
const INSTALL_EXTENSIONS = new Set(['nsp', 'nsz', 'xci', 'xcz']);

function normalizeTitleId(value) {
  if (!value) return '';
  const match = String(value).match(/[0-9a-fA-F]{16}/);
  return match ? match[0].toUpperCase() : '';
}

function extractTitleIds(text) {
  if (!text) return [];
  const matches = String(text).match(TITLE_ID_PATTERN) || [];
  return [...new Set(matches.map(id => id.toUpperCase()))];
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[​-‏﻿]/g, '')
    .replace(/[_.,:;|/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanName(value) {
  return normalizeText(value)
    .replace(/[0-9a-f]{16}/g, ' ')
    .replace(/\bv?\d+(\.\d+){0,3}\b/g, ' ')
    .replace(/\b(app|upd|dlc|base|xci|xcz|nsp|nsz|usa|us|jp|jpn|eur|asia|cn|hk)\b/g, ' ')
    .replace(/\bweixin\b|\bnspp?xci\b|微信号|官方|原版|卡带|提取|整合|最低系统要求/g, ' ')
    .replace(/^[\d\s]+[-~—]+/g, ' ')
    .replace(/[\[\](){}【】「」『』]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const CJK_RE = /[一-鿿぀-ゟ゠-ヿ]/;

function containsCjk(text) {
  return CJK_RE.test(String(text || ''));
}

function pinyinTokens(text, style = pinyin.STYLE_NORMAL) {
  if (!text) return '';
  const normalized = String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFKC');
  const tokens = pinyin(normalized, {
    style,
    heteronym: false,
    segment: false,
  });
  return tokens
    .flat()
    .map(s => s.toLowerCase())
    .filter(Boolean)
    .join(' ');
}

function pinyinInitials(text) {
  return pinyinTokens(text, pinyin.STYLE_FIRST_LETTER);
}

function aliasExpand(text) {
  const ALIASES = {
    '塞尔达': 'Zelda',
    'zelda': '塞尔达',
    '马里奥': 'Mario',
    'mario': '马里奥',
    '宝可梦': 'Pokemon',
    'pokemon': '宝可梦',
    '王国之泪': 'Tears of the Kingdom TOTK',
    'totk': 'Tears of the Kingdom 王国之泪',
    '动森': 'Animal Crossing',
    '动物森友会': 'Animal Crossing',
    'animal crossing': '动物森友会',
    '斯普拉遁': 'Splatoon',
    'splatoon': '斯普拉遁',
    '火焰纹章': 'Fire Emblem',
    'fire emblem': '火焰纹章',
    '勇者斗恶龙': 'Dragon Quest',
    'dragon quest': '勇者斗恶龙',
    '最终幻想': 'Final Fantasy',
    'final fantasy': '最终幻想',
    '真女神转生': 'Shin Megami Tensei',
    'shin megami tensei': '真女神转生',
  };
  const normalized = normalizeText(text);
  const extras = [];
  for (const [key, val] of Object.entries(ALIASES)) {
    if (normalized.includes(key)) extras.push(val);
  }
  return extras.length ? `${normalized} ${extras.join(' ')}` : normalized;
}

function lcsLength(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  const prev = new Array(n + 1).fill(0);
  const curr = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1]);
      }
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

function similarityScore(query, target) {
  if (!query || !target) return 0;
  if (query === target) return 1;

  const q = String(query);
  const t = String(target);
  const maxLen = Math.max(q.length, t.length);
  if (maxLen === 0) return 0;

  let prefixBonus = 0;
  if (t.startsWith(q) || q.startsWith(t)) {
    prefixBonus = 0.9 + 0.1 * (Math.min(q.length, t.length) / maxLen);
  } else {
    const tWords = t.split(/\s+/);
    const qWords = q.split(/\s+/);
    const allStart = qWords.length > 0 && qWords.every(qw => tWords.some(tw => tw.startsWith(qw)));
    if (allStart) prefixBonus = 0.8;
  }

  const lcs = lcsLength(q, t);
  const lcsRatio = lcs / maxLen;
  const dist = levenshtein.get(q, t);
  const levRatio = 1 - dist / maxLen;

  return Math.max(prefixBonus, lcsRatio, levRatio);
}

function tokenSet(text) {
  return new Set(
    cleanName(text)
      .split(/\s+/)
      .filter(w => w.length >= 2)
  );
}

function fuzzyFindBest(query, records, { limit = 5, minScore = 0.55 } = {}) {
  const expandedQuery = aliasExpand(query);
  const queryTokens = tokenSet(expandedQuery);
  const results = [];

  for (const record of records) {
    const target = record.searchableName || cleanName(record.name);
    if (!target) continue;

    if (queryTokens.size) {
      const targetTokens = tokenSet(target);
      let shared = false;
      for (const token of queryTokens) {
        if (targetTokens.has(token)) { shared = true; break; }
      }
      if (!shared) {
        let substrHit = false;
        for (const token of queryTokens) {
          if (target.includes(token)) { substrHit = true; break; }
        }
        if (!substrHit) continue;
      }
    }

    const score = similarityScore(expandedQuery, target);
    if (score < minScore) continue;
    results.push({ item: record, score: Number(score.toFixed(4)) });
  }

  results.sort((a, b) => b.score - a.score || a.item.name.length - b.item.name.length);
  return results.slice(0, limit);
}

function valueFromRecord(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function toTitleRecord(record, key, sourceFile) {
  const id = normalizeTitleId(valueFromRecord(record, ['id', 'titleId', 'title_id']) || key);
  const name = valueFromRecord(record, ['name', 'title', 'formalName', 'displayName']);
  if (!id || !name) return null;

  return {
    id,
    name: String(name),
    publisher: String(valueFromRecord(record, ['publisher', 'publisherName']) || ''),
    releaseDate: String(valueFromRecord(record, ['releaseDate', 'release_date']) || ''),
    iconUrl: String(valueFromRecord(record, ['iconUrl', 'icon_url', 'icon']) || ''),
    bannerUrl: String(valueFromRecord(record, ['bannerUrl', 'banner_url', 'banner']) || ''),
    sourceFile,
  };
}

function enrichRecord(record) {
  const searchableName = cleanName(record.name);
  return {
    ...record,
    searchableName,
    namePinyin: pinyinTokens(record.name),
    nameInitials: pinyinInitials(record.name),
    publisherPinyin: pinyinTokens(record.publisher),
  };
}

function loadTitleList(titleDbDir = config.titleDbDir) {
  const litePath = path.join(titleDbDir, 'titles-lite.json');
  if (fs.existsSync(litePath)) {
    const records = JSON.parse(fs.readFileSync(litePath, 'utf8'));
    const enriched = records.map(record => record.searchableName ? record : enrichRecord(record));
    const byId = new Map(enriched.map(record => [record.id, record]));
    return { records: enriched, byId, missing: [] };
  }

  const records = [];
  const byId = new Map();
  const missing = [];

  for (const source of config.titleDbSources) {
    const filePath = path.join(titleDbDir, source.fileName);
    if (!fs.existsSync(filePath)) {
      missing.push(source.fileName);
      continue;
    }

    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      const record = toTitleRecord(value, key, source.fileName);
      if (!record) continue;
      records.push(enrichRecord(record));

      const existing = byId.get(record.id);
      if (!existing || source.fileName.startsWith('US.')) {
        byId.set(record.id, record);
      }
    }
  }

  return { records, byId, missing };
}

function candidateTextForGame(game) {
  const fileNames = (game.files || [])
    .filter(file => INSTALL_EXTENSIONS.has(file.extension))
    .slice(0, 12)
    .map(file => file.fileName)
    .join(' ');

  return cleanName(`${game.folderName || game.folder_name || ''} ${fileNames}`);
}

function titleIdsForGame(game) {
  const parts = [game.folderName || game.folder_name || ''];
  for (const file of game.files || []) {
    parts.push(file.fileName || '');
  }
  const ids = extractTitleIds(parts.join(' '));
  const expanded = [];
  for (const id of ids) {
    expanded.push(id);
    if (id.endsWith('800')) {
      expanded.push(`${id.slice(0, -3)}000`);
    }
  }
  return [...new Set(expanded)];
}

function statusForScore(score) {
  if (score >= 0.75) return 'matched';
  if (score >= 0.6) return 'needs_review';
  return 'no_match';
}

function emptyMatch() {
  return {
    titleId: '',
    titleName: '',
    publisher: '',
    releaseDate: '',
    iconUrl: '',
    matchType: 'none',
    matchScore: 0,
    matchStatus: 'no_match',
    matchCandidates: [],
  };
}

function scoreSimpleMatch(query, name) {
  if (!query || !name) return 0;
  if (name === query) return 1;
  if (name.includes(query)) return 0.88;

  const words = query.split(' ').filter(part => part.length >= 2);
  if (!words.length) return 0;
  const matched = words.filter(word => name.includes(word)).length;
  const ratio = matched / words.length;
  if (ratio === 1) return 0.72;
  if (ratio >= 0.75) return 0.64;
  return 0;
}

function createMatcher() {
  const { records, byId, missing } = loadTitleList();
  const queryCache = new Map();
  const enableNameMatch = process.env.SWITCH_INSTALLER_ENABLE_NAME_MATCH === '1';
  let fuse = null;

  if (enableNameMatch && records.length) {
    const Fuse = require('fuse.js');
    fuse = new Fuse(records, {
      keys: ['searchableName', 'name'],
      includeScore: true,
      threshold: 0.35,
      ignoreLocation: true,
      minMatchCharLength: 2,
    });
  }

  function fromRecord(record, patch) {
    return {
      titleId: record.id,
      titleName: record.name,
      publisher: record.publisher || '',
      releaseDate: record.releaseDate || '',
      iconUrl: record.iconUrl || '',
      matchType: patch.matchType,
      matchScore: patch.matchScore,
      matchStatus: patch.matchStatus,
      matchCandidates: patch.matchCandidates || [],
    };
  }

  function matchGame(game) {
    const titleIds = titleIdsForGame(game);
    for (const titleId of titleIds) {
      const record = byId.get(titleId);
      if (record) {
        return fromRecord(record, {
          matchType: 'exact_id',
          matchScore: 1,
          matchStatus: 'matched',
          matchCandidates: [{ id: record.id, name: record.name, score: 1 }],
        });
      }
    }

    if (titleIds.length) return emptyMatch();
    if (!enableNameMatch) return emptyMatch();

    const query = candidateTextForGame(game);
    if (!query) return emptyMatch();

    let results = queryCache.get(query);
    if (!results) {
      if (fuse) {
        results = fuse.search(query, { limit: 5 }).map(result => ({
          item: result.item,
          score: Math.max(0, Math.min(1, 1 - (result.score ?? 1))),
        }));
      } else {
        results = [];
        for (const record of records) {
          const score = scoreSimpleMatch(query, record.searchableName || cleanName(record.name));
          if (score > 0) results.push({ item: record, score });
        }
        results.sort((a, b) => b.score - a.score || a.item.name.length - b.item.name.length);
        results = results.slice(0, 5);
      }
      queryCache.set(query, results);
    }

    if (!results.length) return emptyMatch();

    const best = results[0];
    const score = best.score;
    const candidates = results.map(result => ({
      id: result.item.id,
      name: result.item.name,
      score: Number(result.score.toFixed(4)),
    }));

    if (score < 0.6) {
      return {
        ...emptyMatch(),
        matchType: 'fuzzy',
        matchScore: Number(score.toFixed(4)),
        matchCandidates: candidates,
      };
    }

    return fromRecord(best.item, {
      matchType: 'fuzzy',
      matchScore: Number(score.toFixed(4)),
      matchStatus: statusForScore(score),
      matchCandidates: candidates,
    });
  }

  return {
    matchGame,
    stats: {
      records: records.length,
      uniqueTitleIds: byId.size,
      missing,
    },
  };
}

module.exports = {
  aliasExpand,
  candidateTextForGame,
  cleanName,
  containsCjk,
  createMatcher,
  extractTitleIds,
  fuzzyFindBest,
  loadTitleList,
  normalizeTitleId,
  pinyinInitials,
  pinyinTokens,
  similarityScore,
  titleIdsForGame,
};
