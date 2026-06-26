'use strict';

const fs = require('fs');
const path = require('path');
const {
  SchemaBuilder,
  Index,
  Document,
} = require('@oxdev03/node-tantivy-binding');
const config = require('./config');
const titledb = require('./titledb');
const levenshtein = require('fast-levenshtein');

const FIELD_ID = 'id';
const FIELD_FOLDER_NAME = 'folder_name';
const FIELD_FOLDER_NAME_TOKENS = 'folder_name_tokens';
const FIELD_FOLDER_NAME_PINYIN = 'folder_name_pinyin';
const FIELD_FOLDER_NAME_PINYIN_INITIALS = 'folder_name_pinyin_initials';
const FIELD_FOLDER_PATH = 'folder_path';
const FIELD_FILE_NAMES = 'file_names';
const FIELD_FILE_NAMES_TOKENS = 'file_names_tokens';
const FIELD_FILE_COUNT = 'file_count';
const FIELD_FILES_JSON = 'files_json';
const FIELD_TITLE_ID = 'title_id';
const FIELD_TITLE_NAME = 'title_name';
const FIELD_TITLE_NAME_TOKENS = 'title_name_tokens';
const FIELD_TITLE_NAME_PINYIN = 'title_name_pinyin';
const FIELD_TITLE_NAME_PINYIN_INITIALS = 'title_name_pinyin_initials';
const FIELD_PUBLISHER = 'publisher';
const FIELD_PUBLISHER_TOKENS = 'publisher_tokens';
const FIELD_RELEASE_DATE = 'release_date';
const FIELD_ICON_URL = 'icon_url';
const FIELD_MATCH_TYPE = 'match_type';
const FIELD_MATCH_SCORE = 'match_score';
const FIELD_MATCH_STATUS = 'match_status';
const FIELD_MATCH_CANDIDATES_JSON = 'match_candidates_json';

let index = null;

function buildSchema() {
  return new SchemaBuilder()
    .addUnsignedField(FIELD_ID, { stored: true, indexed: true, fast: true })
    .addTextField(FIELD_FOLDER_NAME, { stored: true })
    .addTextField(FIELD_FOLDER_NAME_TOKENS, { stored: true, tokenizer: 'default' })
    .addTextField(FIELD_FOLDER_NAME_PINYIN, { stored: true, tokenizer: 'default' })
    .addTextField(FIELD_FOLDER_NAME_PINYIN_INITIALS, { stored: true, tokenizer: 'default' })
    .addTextField(FIELD_FOLDER_PATH, { stored: true })
    .addTextField(FIELD_FILE_NAMES, { stored: true })
    .addTextField(FIELD_FILE_NAMES_TOKENS, { stored: true, tokenizer: 'default' })
    .addUnsignedField(FIELD_FILE_COUNT, { stored: true, fast: true })
    .addTextField(FIELD_FILES_JSON, { stored: true })
    .addTextField(FIELD_TITLE_ID, { stored: true, tokenizer: 'default' })
    .addTextField(FIELD_TITLE_NAME, { stored: true })
    .addTextField(FIELD_TITLE_NAME_TOKENS, { stored: true, tokenizer: 'default' })
    .addTextField(FIELD_TITLE_NAME_PINYIN, { stored: true, tokenizer: 'default' })
    .addTextField(FIELD_TITLE_NAME_PINYIN_INITIALS, { stored: true, tokenizer: 'default' })
    .addTextField(FIELD_PUBLISHER, { stored: true })
    .addTextField(FIELD_PUBLISHER_TOKENS, { stored: true, tokenizer: 'default' })
    .addTextField(FIELD_RELEASE_DATE, { stored: true })
    .addTextField(FIELD_ICON_URL, { stored: true })
    .addTextField(FIELD_MATCH_TYPE, { stored: true })
    .addTextField(FIELD_MATCH_SCORE, { stored: true })
    .addTextField(FIELD_MATCH_STATUS, { stored: true })
    .addTextField(FIELD_MATCH_CANDIDATES_JSON, { stored: true })
    .build();
}

function tokenizeForIndex(text) {
  if (!text) return '';
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[一-鿿぀-ゟ゠-ヿ]/g, ' $& ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pinyinToken(text) {
  return titledb.pinyinTokens(text).replace(/\s+/g, '');
}

function pinyinInitialsToken(text) {
  return titledb.pinyinInitials(text).replace(/\s+/g, '');
}

function openIndex() {
  if (index) return index;

  const schema = buildSchema();
  fs.mkdirSync(config.tantivyIndexPath, { recursive: true });

  try {
    index = Index.open(config.tantivyIndexPath);
    const existing = JSON.stringify(index.schema.toDict ? index.schema.toDict() : {});
    const expected = JSON.stringify(schema.toDict ? schema.toDict() : {});
    if (existing !== expected) {
      console.warn('[tantivy] schema mismatch; rebuilding index');
      fs.rmSync(config.tantivyIndexPath, { recursive: true, force: true });
      fs.mkdirSync(config.tantivyIndexPath, { recursive: true });
      index = new Index(schema, config.tantivyIndexPath);
    }
  } catch {
    index = new Index(schema, config.tantivyIndexPath);
  }

  return index;
}

function getIndex() {
  return openIndex();
}

function getSearcher() {
  return getIndex().searcher();
}

const LUCENE_SPECIALS = /([+\-!(){}\[\]^"~*?:\\/]|\|\|?|&&)/g;

function escapeTerm(term) {
  return String(term).replace(LUCENE_SPECIALS, '\\$1');
}

const ALIAS_BOOSTS = {
  '塞尔达': ['Zelda'],
  'zelda': ['塞尔达'],
  '马里奥': ['Mario'],
  'mario': ['马里奥'],
  '宝可梦': ['Pokemon'],
  'pokemon': ['宝可梦'],
  '王国之泪': ['Tears of the Kingdom', 'TOTK'],
  'totk': ['Tears of the Kingdom', '王国之泪'],
  '动森': ['Animal Crossing'],
  '动物森友会': ['Animal Crossing'],
  'animal crossing': ['动物森友会'],
  '斯普拉遁': ['Splatoon'],
  'splatoon': ['斯普拉遁'],
  '火焰纹章': ['Fire Emblem'],
  'fire emblem': ['火焰纹章'],
  '勇者斗恶龙': ['Dragon Quest'],
  'dragon quest': ['勇者斗恶龙'],
  '最终幻想': ['Final Fantasy'],
  'final fantasy': ['最终幻想'],
  '真女神转生': ['Shin Megami Tensei'],
  'shin megami tensei': ['真女神转生'],
};

function aliasExpansions(raw) {
  const norm = String(raw).normalize('NFKC').toLowerCase();
  const extras = new Set();
  for (const [key, vals] of Object.entries(ALIAS_BOOSTS)) {
    if (norm.includes(key)) vals.forEach(v => extras.add(v));
  }
  return [...extras];
}

function prefixUpper(prefix) {
  for (let i = prefix.length - 1; i >= 0; i--) {
    if (prefix[i] !== 'z') {
      return prefix.slice(0, i) + String.fromCharCode(prefix.charCodeAt(i) + 1);
    }
  }
  return prefix + '{';
}

function prefixRangeClause(field, prefix, boost) {
  if (!prefix) return null;
  const upper = prefixUpper(prefix);
  return `(${field}:[${prefix} TO ${upper}})^${boost}`;
}

function buildClauses(rawQuery) {
  const text = String(rawQuery || '').normalize('NFKC').trim();
  if (!text) return [];

  const hasCjk = /[一-鿿぀-ゟ゠-ヿ]/.test(text);
  const titleId = text.match(/[0-9a-fA-F]{16}/)?.[0]?.toUpperCase();
  const clauses = [];

  if (titleId) {
    clauses.push(`(${FIELD_TITLE_ID}:${titleId})^10`);
  }

  if (hasCjk) {
    const tokens = tokenizeForIndex(text).split(/\s+/).filter(Boolean).map(escapeTerm);
    if (tokens.length) {
      const phrase = `"${tokens.join(' ')}"`;
      clauses.push(`(${FIELD_FOLDER_NAME_TOKENS}:${phrase})^5`);
      clauses.push(`(${FIELD_TITLE_NAME_TOKENS}:${phrase})^4`);
      clauses.push(`(${FIELD_FILE_NAMES_TOKENS}:${phrase})^2`);
      const charOr = tokens.map(t => `${FIELD_FOLDER_NAME_TOKENS}:${t}`).join(' OR ');
      clauses.push(`(${charOr})^0.5`);
    }
    return clauses;
  }

  const ascii = text.toLowerCase();
  const terms = ascii.split(/\s+/).filter(Boolean).map(escapeTerm);
  if (!terms.length) return clauses;

  const exactOr = (field, boost, fuzzy = false) => {
    const parts = terms.map(t => {
      if (fuzzy && t.length >= 4) return `${field}:${t}~1`;
      return `${field}:${t}`;
    });
    return `(${parts.join(' OR ')})^${boost}`;
  };

  const phrase = `"${terms.join(' ')}"`;
  clauses.push(`(${FIELD_FOLDER_NAME_TOKENS}:${phrase})^4`);
  clauses.push(`(${FIELD_TITLE_NAME_TOKENS}:${phrase})^3`);
  clauses.push(`(${FIELD_FILE_NAMES_TOKENS}:${phrase})^1.5`);

  clauses.push(exactOr(FIELD_FOLDER_NAME_TOKENS, 2.5, true));
  clauses.push(exactOr(FIELD_TITLE_NAME_TOKENS, 2, true));
  clauses.push(exactOr(FIELD_FILE_NAMES_TOKENS, 0.8, true));
  clauses.push(exactOr(FIELD_PUBLISHER_TOKENS, 0.8, true));

  // Prefix matching for each term on token fields (ASCII auto-complete / partial words).
  for (const term of terms) {
    if (term.length < 2) continue;
    const pre = prefixRangeClause(FIELD_FOLDER_NAME_TOKENS, term, 3);
    if (pre) clauses.push(pre);
    const preTitle = prefixRangeClause(FIELD_TITLE_NAME_TOKENS, term, 2);
    if (preTitle) clauses.push(preTitle);
    const preFiles = prefixRangeClause(FIELD_FILE_NAMES_TOKENS, term, 0.8);
    if (preFiles) clauses.push(preFiles);
    const prePub = prefixRangeClause(FIELD_PUBLISHER_TOKENS, term, 0.6);
    if (prePub) clauses.push(prePub);
  }

  const compact = terms.join('');
  const pinyinFull = prefixRangeClause(FIELD_FOLDER_NAME_PINYIN, compact, 2);
  if (pinyinFull) clauses.push(pinyinFull);
  const pinyinInit = prefixRangeClause(FIELD_FOLDER_NAME_PINYIN_INITIALS, compact, 3);
  if (pinyinInit) clauses.push(pinyinInit);
  const titlePinyinFull = prefixRangeClause(FIELD_TITLE_NAME_PINYIN, compact, 1.5);
  if (titlePinyinFull) clauses.push(titlePinyinFull);
  const titlePinyinInit = prefixRangeClause(FIELD_TITLE_NAME_PINYIN_INITIALS, compact, 1.5);
  if (titlePinyinInit) clauses.push(titlePinyinInit);

  for (const alias of aliasExpansions(text)) {
    const aliasTerms = tokenizeForIndex(alias).split(/\s+/).filter(Boolean).map(escapeTerm);
    if (!aliasTerms.length) continue;
    clauses.push(`(${FIELD_TITLE_NAME_TOKENS}:(${aliasTerms.join(' OR ')}))^2.5`);
    clauses.push(`(${FIELD_FOLDER_NAME_TOKENS}:(${aliasTerms.join(' OR ')}))^2`);
  }

  return clauses;
}

function buildQuery(rawQuery) {
  const clauses = buildClauses(rawQuery);
  if (!clauses.length) return '*';
  return clauses.join(' OR ');
}

function normalizeForRank(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[​-‏﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cjkChars(text) {
  return Array.from(normalizeForRank(text).matchAll(/[㐀-鿿぀-ヿ]/g)).map(m => m[0]);
}

function lcsLength(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;
  const prev = new Array(n + 1).fill(0);
  const curr = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) curr[j] = prev[j - 1] + 1;
      else curr[j] = Math.max(prev[j], curr[j - 1]);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

function rankGame(game, query, bm25 = 0) {
  const q = normalizeForRank(query);
  const qNoSpace = q.replace(/\s+/g, '');
  const title = normalizeForRank(game.title_name);
  const folder = normalizeForRank(game.folder_name);
  const files = normalizeForRank(game.file_names);
  const publisher = normalizeForRank(game.publisher);
  const titleId = normalizeForRank(game.title_id);
  const allText = `${title} ${folder} ${files} ${publisher} ${titleId}`;

  const chars = [...new Set(cjkChars(q))];
  const commonChars = chars.length ? chars.filter(ch => allText.includes(ch)).length : 0;

  const maxLen = Math.max(qNoSpace.length, 1);
  const lcs = lcsLength(qNoSpace, allText.replace(/\s+/g, ''));
  const lcsRatio = lcs / maxLen;
  const dist = levenshtein.get(qNoSpace, allText.replace(/\s+/g, ''));
  const levRatio = Math.max(0, 1 - dist / maxLen);

  let score = bm25 * 100;

  if (titleId && q.includes(titleId)) score += 2000;
  if (q && title === q) score += 1200;
  if (q && folder === q) score += 1000;
  if (q && title.includes(q)) score += 600;
  if (q && folder.includes(q)) score += 500;
  if (q && files.includes(q)) score += 350;
  if (q && publisher.includes(q)) score += 200;

  if (qNoSpace) {
    if (title.replace(/\s+/g, '').startsWith(qNoSpace) || folder.replace(/\s+/g, '').startsWith(qNoSpace)) score += 400;
    if (title.replace(/\s+/g, '').includes(qNoSpace) || folder.replace(/\s+/g, '').includes(qNoSpace)) score += 200;
  }

  score += lcsRatio * 300;
  score += levRatio * 200;

  if (chars.length && commonChars === chars.length) score += 250;
  score += commonChars * 30;

  if (game.match_status === 'matched') score += 80;
  if (game.match_status === 'needs_review') score += 25;
  if (game.match_status === 'fuzzy_matched') score += 50;
  score += Math.round((Number(game.match_score) || 0) * 60);

  const fileCount = Math.min(Number(game.file_count) || 0, 30);
  score -= fileCount * 2;

  const depth = game.folder_path ? game.folder_path.split(path.sep).filter(Boolean).length : 0;
  if (depth > 5) score -= (depth - 5) * 4;

  return score;
}

function docToGame(doc) {
  const d = doc.toDict();
  return {
    id: Number(d[FIELD_ID]?.[0]),
    folder_name: d[FIELD_FOLDER_NAME]?.[0] || '',
    folder_path: d[FIELD_FOLDER_PATH]?.[0] || '',
    file_count: Number(d[FIELD_FILE_COUNT]?.[0] || 0),
    file_names: d[FIELD_FILE_NAMES]?.[0] || '',
    files: JSON.parse(d[FIELD_FILES_JSON]?.[0] || '[]'),
    title_id: d[FIELD_TITLE_ID]?.[0] || '',
    title_name: d[FIELD_TITLE_NAME]?.[0] || '',
    publisher: d[FIELD_PUBLISHER]?.[0] || '',
    release_date: d[FIELD_RELEASE_DATE]?.[0] || '',
    icon_url: d[FIELD_ICON_URL]?.[0] || '',
    match_type: d[FIELD_MATCH_TYPE]?.[0] || 'none',
    match_score: Number(d[FIELD_MATCH_SCORE]?.[0] || 0),
    match_status: d[FIELD_MATCH_STATUS]?.[0] || 'no_match',
    match_candidates: JSON.parse(d[FIELD_MATCH_CANDIDATES_JSON]?.[0] || '[]'),
  };
}

function searchGames(query, { page = 1, limit = 20 } = {}) {
  const idx = getIndex();
  const searcher = idx.searcher();
  const offset = (Math.max(1, page) - 1) * limit;

  const q = buildQuery(query);
  const parsed = idx.parseQuery(q, [
    FIELD_FOLDER_NAME_TOKENS,
    FIELD_FILE_NAMES_TOKENS,
    FIELD_TITLE_NAME_TOKENS,
    FIELD_TITLE_ID,
    FIELD_PUBLISHER_TOKENS,
    FIELD_FOLDER_NAME_PINYIN,
    FIELD_FOLDER_NAME_PINYIN_INITIALS,
    FIELD_TITLE_NAME_PINYIN,
    FIELD_TITLE_NAME_PINYIN_INITIALS,
  ]);
  const candidateLimit = Math.min(Math.max(offset + limit, 200), 2000);
  const result = searcher.search(parsed, candidateLimit, true);

  const rows = result.hits
    .map(hit => ({ game: docToGame(searcher.doc(hit.docAddress)), bm25: Number(hit.score || 0) }))
    .map(({ game, bm25 }) => ({ game, rank: rankGame(game, query, bm25) }))
    .sort((a, b) => b.rank - a.rank || a.game.id - b.game.id)
    .slice(offset, offset + limit)
    .map(row => row.game);

  return {
    total: Number(result.count || 0),
    page,
    limit,
    rows,
  };
}

function suggestGames(query, limit = 8) {
  const result = searchGames(query, { page: 1, limit });
  return result.rows.map(game => ({
    id: game.id,
    title: game.title_name || game.folder_name,
    title_id: game.title_id,
    icon_url: game.icon_url,
    match_status: game.match_status,
  }));
}

function getGameById(id) {
  const idx = getIndex();
  const searcher = idx.searcher();
  const query = idx.parseQuery(`${FIELD_ID}:${id}`);
  const result = searcher.search(query, 1);
  if (!result.hits.length) return null;
  const doc = searcher.doc(result.hits[0].docAddress);
  return docToGame(doc);
}

function getAllGames({ status } = {}) {
  const idx = getIndex();
  const searcher = idx.searcher();
  const parsed = idx.parseQuery('*', [FIELD_FOLDER_NAME_TOKENS]);
  const result = searcher.search(parsed, 100000, true);
  const games = result.hits.map(hit => docToGame(searcher.doc(hit.docAddress)));
  if (status) return games.filter(g => g.match_status === status);
  return games;
}

function indexGames(games) {
  const idx = getIndex();
  const writer = idx.writer();

  for (const game of games) {
    const folderName = game.folderName || '';
    const titleName = game.titleName || '';
    const publisher = game.publisher || '';

    const doc = new Document();
    doc.addUnsigned(FIELD_ID, game.id);
    doc.addText(FIELD_FOLDER_NAME, folderName);
    doc.addText(FIELD_FOLDER_NAME_TOKENS, tokenizeForIndex(folderName));
    doc.addText(FIELD_FOLDER_NAME_PINYIN, pinyinToken(folderName));
    doc.addText(FIELD_FOLDER_NAME_PINYIN_INITIALS, pinyinInitialsToken(folderName));
    doc.addText(FIELD_FOLDER_PATH, game.folderPath);
    doc.addText(FIELD_FILE_NAMES, game.fileNames.join(' '));
    doc.addText(FIELD_FILE_NAMES_TOKENS, tokenizeForIndex(game.fileNames.join(' ')));
    doc.addUnsigned(FIELD_FILE_COUNT, game.fileCount);
    doc.addText(FIELD_FILES_JSON, JSON.stringify(game.files));
    doc.addText(FIELD_TITLE_ID, game.titleId || '');
    doc.addText(FIELD_TITLE_NAME, titleName);
    doc.addText(FIELD_TITLE_NAME_TOKENS, tokenizeForIndex(titleName));
    doc.addText(FIELD_TITLE_NAME_PINYIN, pinyinToken(titleName));
    doc.addText(FIELD_TITLE_NAME_PINYIN_INITIALS, pinyinInitialsToken(titleName));
    doc.addText(FIELD_PUBLISHER, publisher);
    doc.addText(FIELD_PUBLISHER_TOKENS, tokenizeForIndex(publisher));
    doc.addText(FIELD_RELEASE_DATE, game.releaseDate || '');
    doc.addText(FIELD_ICON_URL, game.iconUrl || '');
    doc.addText(FIELD_MATCH_TYPE, game.matchType || 'none');
    doc.addText(FIELD_MATCH_SCORE, String(game.matchScore || 0));
    doc.addText(FIELD_MATCH_STATUS, game.matchStatus || 'no_match');
    doc.addText(FIELD_MATCH_CANDIDATES_JSON, JSON.stringify(game.matchCandidates || []));
    writer.addDocument(doc);
  }

  writer.commit();
  idx.reload();
  writer.waitMergingThreads();
}

function clearIndex() {
  if (index) {
    index = null;
  }
  fs.rmSync(config.tantivyIndexPath, { recursive: true, force: true });
  fs.mkdirSync(config.tantivyIndexPath, { recursive: true });
  openIndex();
}

function getStats() {
  const searcher = getSearcher();
  return { games: searcher.numDocs };
}

module.exports = {
  tokenizeForIndex,
  buildQuery,
  openIndex,
  getIndex,
  getSearcher,
  searchGames,
  suggestGames,
  getGameById,
  getAllGames,
  indexGames,
  clearIndex,
  getStats,
};
