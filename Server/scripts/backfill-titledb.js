'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const titledb = require('../src/titledb');
const tantivy = require('../src/tantivy');

const PATCH_PATH = path.join(config.dataDir, 'titledb-patches.json');

function statusForScore(score) {
  if (score >= 0.85) return 'matched';
  if (score >= 0.65) return 'needs_review';
  return 'no_match';
}

async function runBackfill() {
  console.log('[backfill] loading titleDB...');
  const { records } = titledb.loadTitleList();
  console.log(`[backfill] titleDB records=${records.length}`);

  console.log('[backfill] loading unmatched games from index...');
  const allGames = tantivy.getAllGames();
  const unmatched = allGames.filter(g => !g.title_id && (g.match_status === 'no_match' || g.match_status === 'needs_review'));
  console.log(`[backfill] unmatched games=${unmatched.length}`);

  const existing = fs.existsSync(PATCH_PATH) ? JSON.parse(fs.readFileSync(PATCH_PATH, 'utf8')) : {};
  const patches = existing.patches || existing;
  let improved = 0;
  let skipped = 0;

  for (let i = 0; i < unmatched.length; i++) {
    const game = unmatched[i];
    if ((i + 1) % 100 === 0) {
      console.log(`[backfill] ${i + 1}/${unmatched.length}... improved=${improved}`);
    }

    const key = game.folder_path || game.folder_name;
    const existingPatch = patches[key];

    const query = titledb.candidateTextForGame(game);
    if (!query) {
      skipped++;
      continue;
    }

    const results = titledb.fuzzyFindBest(query, records, { limit: 3, minScore: 0.55 });
    if (!results.length) {
      skipped++;
      continue;
    }

    const best = results[0];
    const score = best.score;
    const status = statusForScore(score);

    if (existingPatch && Number(existingPatch.matchScore) >= score) {
      skipped++;
      continue;
    }

    if (status === 'no_match') {
      skipped++;
      continue;
    }

    const candidates = results.map(r => ({
      id: r.item.id,
      name: r.item.name,
      score: r.score,
    }));

    patches[key] = {
      titleId: best.item.id,
      titleName: best.item.name,
      publisher: best.item.publisher || '',
      releaseDate: best.item.releaseDate || '',
      iconUrl: best.item.iconUrl || '',
      matchType: 'fuzzy_matched',
      matchScore: score,
      matchStatus: status,
      matchCandidates: candidates,
    };
    improved++;
  }

  fs.writeFileSync(PATCH_PATH, JSON.stringify({ patches }, null, 2));
  console.log(`[backfill] done. unmatched=${unmatched.length}, improved=${improved}, skipped=${skipped}`);
  console.log(`[backfill] wrote ${PATCH_PATH}`);
}

runBackfill().catch(err => {
  console.error('[backfill] failed:', err);
  process.exit(1);
});
