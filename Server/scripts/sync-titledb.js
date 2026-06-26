'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../src/config');

async function download(source, force) {
  fs.mkdirSync(config.titleDbDir, { recursive: true });
  const targetPath = path.join(config.titleDbDir, source.fileName);
  const tmpPath = `${targetPath}.tmp`;

  if (!force && fs.existsSync(targetPath) && fs.statSync(targetPath).size > 1024) {
    console.log(`[titledb] exists: ${targetPath}`);
    return;
  }

  console.log(`[titledb] downloading ${source.url}`);
  const res = await fetch(source.url);
  if (!res.ok) {
    throw new Error(`Failed to download ${source.url}: HTTP ${res.status}`);
  }

  const text = await res.text();
  JSON.parse(text);
  fs.writeFileSync(tmpPath, text, 'utf8');
  fs.renameSync(tmpPath, targetPath);
  console.log(`[titledb] saved ${targetPath} (${Buffer.byteLength(text)} bytes)`);
}

function normalizeTitleId(value) {
  const match = String(value || '').match(/[0-9a-fA-F]{16}/);
  return match ? match[0].toUpperCase() : '';
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/[_.,:;|/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function valueFromRecord(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function buildLiteIndex() {
  const byId = new Map();

  for (const source of config.titleDbSources) {
    const filePath = path.join(config.titleDbDir, source.fileName);
    if (!fs.existsSync(filePath)) continue;

    console.log(`[titledb] reading ${filePath}`);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    for (const [key, record] of Object.entries(parsed)) {
      const id = normalizeTitleId(valueFromRecord(record, ['id', 'titleId', 'title_id']) || key);
      const name = valueFromRecord(record, ['name', 'title', 'formalName', 'displayName']);
      if (!id || !name) continue;

      const item = {
        id,
        name: String(name),
        publisher: String(valueFromRecord(record, ['publisher', 'publisherName']) || ''),
        releaseDate: String(valueFromRecord(record, ['releaseDate', 'release_date']) || ''),
        iconUrl: String(valueFromRecord(record, ['iconUrl', 'icon_url', 'icon']) || ''),
        sourceFile: source.fileName,
        searchableName: normalizeText(name),
      };

      const existing = byId.get(id);
      if (!existing || source.fileName.startsWith('US.')) {
        byId.set(id, item);
      }
    }
  }

  const lite = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const targetPath = path.join(config.titleDbDir, 'titles-lite.json');
  fs.writeFileSync(targetPath, JSON.stringify(lite), 'utf8');
  console.log(`[titledb] wrote ${targetPath} (${lite.length} titles)`);
}

async function main() {
  const force = process.argv.includes('--force');
  for (const source of config.titleDbSources) {
    await download(source, force);
  }
  buildLiteIndex();
}

main().catch(err => {
  console.error('[titledb] failed:', err);
  process.exit(1);
});
