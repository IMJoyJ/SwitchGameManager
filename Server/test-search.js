'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.SWITCH_INSTALLER_WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-test-'));

const tantivy = require('./src/tantivy');

const games = [
  {
    id: 1,
    folderName: '塞尔达传说 王国之泪',
    folderPath: 'Switch/A/塞尔达传说 王国之泪',
    fileNames: ['塞尔达传说 王国之泪 [01008CF01BAAC000][v0].nsp'],
    fileCount: 1,
    files: [{ fileName: '塞尔达传说 王国之泪 [01008CF01BAAC000][v0].nsp' }],
    titleId: '01008CF01BAAC000',
    titleName: 'The Legend of Zelda: Tears of the Kingdom',
    publisher: 'Nintendo',
    releaseDate: '2023-05-12',
    iconUrl: '',
    matchType: 'exact_id',
    matchScore: 1,
    matchStatus: 'matched',
    matchCandidates: [],
  },
  {
    id: 2,
    folderName: '宝可梦 朱',
    folderPath: 'Switch/B/宝可梦 朱',
    fileNames: ['Pokemon Scarlet [0100A3D008C5C000].xci'],
    fileCount: 1,
    files: [{ fileName: 'Pokemon Scarlet [0100A3D008C5C000].xci' }],
    titleId: '0100A3D008C5C000',
    titleName: 'Pokémon Scarlet',
    publisher: 'Nintendo',
    releaseDate: '2022-11-18',
    iconUrl: '',
    matchType: 'exact_id',
    matchScore: 1,
    matchStatus: 'matched',
    matchCandidates: [],
  },
  {
    id: 3,
    folderName: 'Super Mario Odyssey',
    folderPath: 'Switch/C/Super Mario Odyssey',
    fileNames: ['Super Mario Odyssey [0100000000010000].nsp'],
    fileCount: 1,
    files: [{ fileName: 'Super Mario Odyssey [0100000000010000].nsp' }],
    titleId: '0100000000010000',
    titleName: 'Super Mario Odyssey',
    publisher: 'Nintendo',
    releaseDate: '2017-10-27',
    iconUrl: '',
    matchType: 'exact_id',
    matchScore: 1,
    matchStatus: 'matched',
    matchCandidates: [],
  },
  {
    id: 4,
    folderName: 'Mario Kart 8 Deluxe',
    folderPath: 'Switch/D/Mario Kart 8 Deluxe',
    fileNames: ['Mario Kart 8 Deluxe [0100152000022000].nsp'],
    fileCount: 1,
    files: [{ fileName: 'Mario Kart 8 Deluxe [0100152000022000].nsp' }],
    titleId: '0100152000022000',
    titleName: 'Mario Kart 8 Deluxe',
    publisher: 'Nintendo',
    releaseDate: '2017-04-28',
    iconUrl: '',
    matchType: 'exact_id',
    matchScore: 1,
    matchStatus: 'matched',
    matchCandidates: [],
  },
];

tantivy.clearIndex();
tantivy.indexGames(games);

function test(q) {
  const r = tantivy.searchGames(q, { limit: 10 });
  console.log(`\nQuery: ${q}`);
  console.log('Query string:', tantivy.buildQuery?.(q) || 'n/a');
  console.log(r.rows.map(g => `  #${g.id} ${g.title_name || g.folder_name}`).join('\n'));
}

test('zelda');
test('塞尔达');
test('bkm');
test('baokemeng');
test('mario kart');
test('01008CF01BAAC000');

console.log('\nSuggest zel:', JSON.stringify(tantivy.suggestGames('zel', 3), null, 2));
