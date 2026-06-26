'use strict';

const fs = require('fs');
const readline = require('readline');
const path = require('path');
const config = require('../src/config');

function parseLine(line) {
  let depth = 0;
  let rest = line;
  const root = rest.match(/^\|[\u2014-]+(.+)$/);
  if (root) return { depth, name: root[1].trim() };

  while (rest.startsWith('| ')) {
    depth++;
    rest = rest.slice(2);
  }
  if (!rest.startsWith('|-')) return null;
  const name = rest.slice(2).trim();
  return { depth, name };
}

function parseArgs(argv) {
  let treeFile = process.env.TREE_FILE || config.treeFile;
  let dryRun = false;

  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (!arg.startsWith('--')) {
      treeFile = arg;
    }
  }

  return { treeFile: path.resolve(treeFile), dryRun };
}

function createTitleMatcher(dryRun) {
  try {
    return require('../src/titledb').createMatcher();
  } catch (err) {
    if (!dryRun) throw err;
    console.warn(`[import] titleDB matcher unavailable in dry-run: ${err.message}`);
    return {
      matchGame() {
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
      },
      stats: { records: 0, uniqueTitleIds: 0, missing: [] },
    };
  }
}

function loadPatches() {
  const patchPath = path.join(config.dataDir, 'titledb-patches.json');
  if (!fs.existsSync(patchPath)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(patchPath, 'utf8'));
    return data.patches || data || {};
  } catch (err) {
    console.warn(`[import] failed to load patches: ${err.message}`);
    return {};
  }
}

async function runImport() {
  const startTime = Date.now();
  const { treeFile, dryRun } = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(treeFile)) {
    throw new Error(`Tree file not found: ${treeFile}`);
  }

  if (dryRun) {
    console.log('[import] dry run enabled; Tantivy index will not be modified');
  } else {
    console.log('[import] clearing Tantivy index...');
    var tantivy = require('../src/tantivy');
    tantivy.clearIndex();
  }

  const stream = fs.createReadStream(treeFile, { encoding: 'utf16le' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const matcher = createTitleMatcher(dryRun);
  const patches = loadPatches();
  const patchKeys = Object.keys(patches);
  if (patchKeys.length) {
    console.log(`[import] loaded ${patchKeys.length} titledb patches`);
  }

  const stack = []; // { depth, name, path, gameId, isSwitchRoot }
  let lineCount = 0;
  let parsedCount = 0;
  let fileCount = 0;
  let gameCount = 0;
  let underSwitch = false;
  let switchDepth = -1;
  let currentGame = null; // { id, folderName, folderPath, files[], fileNames }
  const gamesBatch = [];
  const BATCH_SIZE = 500;
  const matchCounts = { matched: 0, needs_review: 0, no_match: 0 };

  console.log(`[import] parsing ${treeFile}...`);
  console.log(`[import] titleDB records=${matcher.stats.records}, unique=${matcher.stats.uniqueTitleIds}`);
  if (matcher.stats.missing.length) {
    console.warn(`[import] titleDB missing files: ${matcher.stats.missing.join(', ')}`);
  }

  async function flushGames() {
    if (gamesBatch.length === 0) return;
    if (dryRun) {
      console.log(`[import] dry-run batch of ${gamesBatch.length} games...`);
    } else {
      console.log(`[import] indexing batch of ${gamesBatch.length} games...`);
      tantivy.indexGames(gamesBatch);
    }
    gamesBatch.length = 0;
  }

  async function queueCurrentGame() {
    if (!currentGame) return;
    let match = matcher.matchGame(currentGame);
    if (!match.titleId) {
      const patch = patches[currentGame.folderPath] || patches[currentGame.folderName];
      if (patch) {
        match = {
          titleId: patch.titleId || '',
          titleName: patch.titleName || '',
          publisher: patch.publisher || '',
          releaseDate: patch.releaseDate || '',
          iconUrl: patch.iconUrl || '',
          matchType: patch.matchType || 'fuzzy_matched',
          matchScore: Number(patch.matchScore || 0),
          matchStatus: patch.matchStatus || 'needs_review',
          matchCandidates: patch.matchCandidates || [],
        };
      }
    }
    Object.assign(currentGame, match);
    matchCounts[match.matchStatus] = (matchCounts[match.matchStatus] || 0) + 1;
    gamesBatch.push(currentGame);
    if (gamesBatch.length >= BATCH_SIZE) await flushGames();
  }

  for await (const rawLine of rl) {
    lineCount++;
    const line = rawLine.replace(/^﻿/, '');
    const parsed = parseLine(line);
    if (!parsed) continue;
    parsedCount++;

    const { depth, name } = parsed;

    // Maintain stack so same-depth siblings replace each other.
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();

    // Detect Switch root at any depth
    if (name === 'Switch' && switchDepth === -1) {
      switchDepth = depth;
      stack.push({ depth, name, path: '', isSwitchRoot: true });
      underSwitch = true;
      continue;
    }

    if (!underSwitch) continue;

    // Skip siblings after Switch section ends
    if (depth <= switchDepth && name !== 'Switch') {
      underSwitch = false;
      continue;
    }

    const parent = stack[stack.length - 1];
    const parentPath = parent ? parent.path : '';
    const fullPath = parentPath ? path.join(parentPath, name) : name;

    const ext = name.split('.').pop().toLowerCase();
    const isSwitchFile = ['nsp', 'nsz', 'xci', 'xcz'].includes(ext);

    if (isSwitchFile) {
      if (!parent || parent.isSwitchRoot) continue;

      const gameFolderDepth = switchDepth + 4;
      // Find nearest ancestor that is already a game, or the game folder at expected depth
      let gameEntry = null;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].gameId) {
          gameEntry = stack[i];
          break;
        }
        if (stack[i].depth === gameFolderDepth) {
          gameEntry = stack[i];
          break;
        }
      }

      if (!gameEntry) {
        // Fallback: promote immediate parent
        parent.gameId = ++gameCount;
        gameEntry = parent;
      }

      if (!gameEntry.gameId) {
        gameEntry.gameId = ++gameCount;
      }

      const fileType = classifyFile(name);
      const fileRecord = {
        fileName: name,
        filePath: fullPath,
        fileType,
        extension: ext,
        sizeBytes: null,
      };

      if (gameEntry.gameId === currentGame?.id) {
        // Same game, will add below
      } else {
        // Flush previous game if any
        await queueCurrentGame();
        const resolvedFolderPath = normalizeTreePath(gameEntry.path);
        currentGame = {
          id: gameEntry.gameId,
          folderName: gameEntry.name,
          folderPath: resolvedFolderPath,
          files: [],
          fileNames: [],
          fileCount: 0,
        };
      }

      // Rebase file path onto resolved folder path
      const relativeFilePath = gameEntry.path
        ? fullPath.slice(gameEntry.path.length + 1)
        : fullPath;
      const resolvedFilePath = relativeFilePath
        ? path.join(currentGame.folderPath, relativeFilePath)
        : currentGame.folderPath;
      fileRecord.filePath = resolvedFilePath;
      currentGame.files.push(fileRecord);
      currentGame.fileNames.push(name);
      currentGame.fileCount++;
      fileCount++;
    } else {
      stack.push({ depth, name, path: fullPath, gameId: null });
    }
  }

  await queueCurrentGame();
  await flushGames();

  // Run optimize? Tantivy binding doesn't expose optimize directly.
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`[import] done in ${elapsed}s`);
  console.log(`[import] parsed ${parsedCount} lines, ${gameCount} games, ${fileCount} files`);
  console.log(`[import] title matches ${JSON.stringify(matchCounts)}`);
  if (!dryRun) {
    const stats = tantivy.getStats();
    console.log(`[import] indexed ${stats.games} documents`);
  }
}

function classifyFile(fileName) {
  const lower = fileName.toLowerCase();
  const ext = lower.split('.').pop();
  const base = lower.replace('.' + ext, '');

  if (base.includes('dlc') || base.includes('[dlc]')) return 'dlc';
  if (base.includes('upd') || base.includes('update') || base.includes('[更新]')) return 'upd';
  if (base.includes('app') || base.includes('base') || base.includes('[本体]') || base.includes('xci')) return 'base';
  return 'other';
}

function normalizeTreePath(treeFolderPath) {
  return treeFolderPath
    .split(path.sep)
    .filter(Boolean)
    .join(path.sep);
}

runImport().catch(err => {
  console.error('[import] failed:', err);
  process.exit(1);
});
