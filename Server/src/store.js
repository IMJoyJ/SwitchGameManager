'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');

let records = null;
let nextId = 1;

function loadRecords() {
  if (records) return records;
  records = [];
  fs.mkdirSync(path.dirname(config.historyFile), { recursive: true });

  if (!fs.existsSync(config.historyFile)) {
    return records;
  }

  const lines = fs.readFileSync(config.historyFile, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      records.push(r);
      if (r.id >= nextId) nextId = r.id + 1;
    } catch {
      // skip corrupt line
    }
  }
  return records;
}

function persist() {
  const data = records.map(r => JSON.stringify(r)).join('\n');
  fs.writeFileSync(config.historyFile, data ? data + '\n' : '', 'utf8');
}

function createInstallRecord({ gameId, ftpUrl, targetPath, folderName }) {
  loadRecords();
  const record = {
    id: nextId++,
    gameId,
    ftpUrl,
    targetPath,
    folderName,
    status: 'pending',
    progress: 0,
    message: 'Queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  records.push(record);
  persist();
  return record;
}

function updateInstallRecord(id, patch) {
  loadRecords();
  const record = records.find(r => r.id === id);
  if (!record) return null;
  Object.assign(record, patch, { updatedAt: new Date().toISOString() });
  persist();
  return record;
}

function getInstallRecord(id) {
  loadRecords();
  return records.find(r => r.id === id) || null;
}

function getInstallHistory(limit = 50) {
  loadRecords();
  return records
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, limit);
}

module.exports = {
  createInstallRecord,
  updateInstallRecord,
  getInstallRecord,
  getInstallHistory,
};
