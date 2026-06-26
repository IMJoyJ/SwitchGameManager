'use strict';

const path = require('path');

const WORK_DIR = process.env.SWITCH_INSTALLER_WORK_DIR || '/data/SwitchInstaller';
const DATA_DIR = process.env.SWITCH_INSTALLER_DATA_DIR || path.join(WORK_DIR, 'data');
const LOGS_DIR = path.join(WORK_DIR, 'logs');
const SOURCE_TREES_DIR = path.join(DATA_DIR, 'source-trees');
const TITLEDB_DIR = path.join(DATA_DIR, 'titledb');
const COVERS_DIR = path.join(DATA_DIR, 'covers');
const SWITCH_ROOT = process.env.SWITCH_INSTALLER_SWITCH_ROOT || '/mnt/cd2/CloudDrive/115/游戏/主机和掌机游戏/Switch';
const TREE_FILE = process.env.SWITCH_INSTALLER_TREE_FILE || path.join(SOURCE_TREES_DIR, '游戏20260303203832_目录树.txt');
const TANTIVY_INDEX_PATH = path.join(DATA_DIR, 'tantivy-index');
const HISTORY_FILE = path.join(DATA_DIR, 'install-history.jsonl');

module.exports = {
  port: process.env.PORT || 18080,
  host: process.env.HOST || '0.0.0.0',
  workDir: WORK_DIR,
  dataDir: DATA_DIR,
  logsDir: LOGS_DIR,
  sourceTreesDir: SOURCE_TREES_DIR,
  titleDbDir: TITLEDB_DIR,
  coversDir: COVERS_DIR,
  switchRoot: SWITCH_ROOT,
  treeFile: TREE_FILE,
  tantivyIndexPath: TANTIVY_INDEX_PATH,
  historyFile: HISTORY_FILE,
  titleDbSources: [
    {
      fileName: 'US.en.json',
      url: 'https://raw.githubusercontent.com/blawar/titledb/master/US.en.json',
    },
    {
      fileName: 'JP.ja.json',
      url: 'https://raw.githubusercontent.com/blawar/titledb/master/JP.ja.json',
    },
  ],
  ftp: {
    timeout: 30000,
    preflightTimeout: 8000,
    retryCount: 3,
    retryIntervalMs: 5000,
  },
};
