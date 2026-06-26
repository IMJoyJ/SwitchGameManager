'use strict';

const express = require('express');
const path = require('path');
const config = require('./config');
const tantivy = require('./tantivy');
const store = require('./store');
const ftp = require('./ftp');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// In-memory install queue
const installQueue = [];
let isProcessing = false;

function sendJson(res, data, status = 200) {
  res.status(status).json({ success: status < 400, ...data });
}

async function processQueue() {
  if (isProcessing || installQueue.length === 0) return;
  isProcessing = true;

  try {
    while (installQueue.length > 0) {
      const record = installQueue.shift();
      const game = tantivy.getGameById(record.gameId);
      if (!game) {
        store.updateInstallRecord(record.id, { status: 'failed', message: 'Game not found' });
        continue;
      }

      try {
        await ftp.installGame(
          record,
          game,
          (progress) => {
            store.updateInstallRecord(record.id, { progress });
          },
          (patch) => {
            store.updateInstallRecord(record.id, patch);
          }
        );
      } catch (err) {
        store.updateInstallRecord(record.id, { status: 'failed', message: err.message });
      }
    }
  } finally {
    isProcessing = false;
  }
}

// API Routes
app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const page = parseInt(req.query.page, 10) || 1;
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

  if (!q) {
    return sendJson(res, { error: 'Query parameter q is required' }, 400);
  }

  const result = tantivy.searchGames(q, { page, limit });
  sendJson(res, result);
});

app.get('/api/search/suggest', (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const limit = Math.min(parseInt(req.query.limit, 10) || 8, 20);

  if (!q) {
    return sendJson(res, { suggestions: [] });
  }

  const suggestions = tantivy.suggestGames(q, limit);
  sendJson(res, { suggestions });
});

app.get('/api/games/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const game = tantivy.getGameById(id);
  if (!game) return sendJson(res, { error: 'Game not found' }, 404);
  sendJson(res, { game });
});

app.post('/api/ftp/preflight', async (req, res) => {
  const { ftpUrl, targetPath = '/' } = req.body || {};
  if (!ftpUrl) {
    return sendJson(res, { error: 'ftpUrl is required' }, 400);
  }

  const result = await ftp.preflightFtp(ftpUrl, targetPath);
  if (!result.ok) return sendJson(res, { error: result.message }, 400);
  sendJson(res, result);
});

app.post('/api/install', async (req, res) => {
  const { gameId, ftpUrl, targetPath = '/' } = req.body || {};
  if (!gameId || !ftpUrl) {
    return sendJson(res, { error: 'gameId and ftpUrl are required' }, 400);
  }

  const game = tantivy.getGameById(parseInt(gameId, 10));
  if (!game) return sendJson(res, { error: 'Game not found' }, 404);

  const preflight = await ftp.preflightFtp(ftpUrl, targetPath);
  if (!preflight.ok) {
    return sendJson(res, { error: preflight.message }, 400);
  }

  const record = store.createInstallRecord({
    gameId: game.id,
    ftpUrl,
    targetPath,
    folderName: game.folder_name,
  });

  installQueue.push(record);
  processQueue().catch(err => console.error('[queue] processing error:', err));

  sendJson(res, { recordId: record.id, status: 'queued', game: { id: game.id, folder_name: game.folder_name } });
});

app.get('/api/install/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  sendJson(res, { history: store.getInstallHistory(limit) });
});

app.get('/api/install/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const record = store.getInstallRecord(id);
  if (!record) return sendJson(res, { error: 'Install record not found' }, 404);
  sendJson(res, { record });
});

// Health
app.get('/api/health', (req, res) => {
  const stats = tantivy.getStats();
  sendJson(res, { status: 'ok', ...stats });
});

// Start server
app.listen(config.port, config.host, () => {
  tantivy.openIndex();
  console.log(`[server] Switch Installer running at http://${config.host}:${config.port}`);
  console.log(`[server] Tantivy index: ${config.tantivyIndexPath}`);
});

module.exports = app;
