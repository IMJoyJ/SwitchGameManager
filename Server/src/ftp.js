'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const { PassThrough } = require('stream');
const ftp = require('basic-ftp');
const config = require('./config');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseFtpUrl(ftpUrl) {
  const url = new URL(ftpUrl);
  if (url.protocol !== 'ftp:') throw new Error('Only ftp:// URLs are supported');
  return {
    host: url.hostname,
    port: parseInt(url.port || '21', 10),
    user: decodeURIComponent(url.username || 'anonymous'),
    pass: decodeURIComponent(url.password || 'anonymous'),
    targetPath: url.pathname && url.pathname !== '/' ? url.pathname : '/',
  };
}

async function uploadFileWithProgress(client, localPath, remoteName, onProgress) {
  const stat = fs.statSync(localPath);
  const total = stat.size;
  const readStream = fs.createReadStream(localPath);
  const pass = new PassThrough();
  let uploaded = 0;

  pass.on('data', chunk => {
    uploaded += chunk.length;
    onProgress(uploaded, total);
  });

  readStream.pipe(pass);
  await client.uploadFrom(pass, remoteName);
  return total;
}

function isInstallableFile(file) {
  return file && ['nsp', 'nsz', 'xci', 'xcz'].includes(file.extension);
}

function localPathForFile(file) {
  const localPath = path.resolve(config.switchRoot, file.filePath);
  const rootPath = path.resolve(config.switchRoot);
  if (!localPath.startsWith(rootPath + path.sep)) {
    throw new Error(`Unsafe file path: ${file.filePath}`);
  }
  return localPath;
}

function detectHttpService(host, port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port, timeout: 2000 });
    let settled = false;

    function finish(result) {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    }

    socket.on('connect', () => {
      socket.write('HEAD / HTTP/1.0\r\n\r\n');
    });
    socket.on('data', chunk => {
      finish(/^HTTP\//i.test(chunk.toString('utf8')));
    });
    socket.on('timeout', () => finish(false));
    socket.on('error', () => finish(false));
    socket.on('end', () => finish(false));
  });
}

async function preflightFtp(ftpUrl, targetPath = '/') {
  let ftpInfo;
  try {
    ftpInfo = parseFtpUrl(ftpUrl);
  } catch (err) {
    return { ok: false, message: err.message };
  }

  const remotePath = targetPath || ftpInfo.targetPath || '/';
  const client = new ftp.Client(config.ftp.preflightTimeout || config.ftp.timeout);
  try {
    await client.access({
      host: ftpInfo.host,
      port: ftpInfo.port,
      user: ftpInfo.user,
      password: ftpInfo.pass,
      secure: false,
    });
    await client.cd(remotePath);
    return { ok: true, message: `FTP reachable: ${ftpInfo.host}:${ftpInfo.port}${remotePath}` };
  } catch (err) {
    const looksHttp = await detectHttpService(ftpInfo.host, ftpInfo.port);
    if (looksHttp) {
      return {
        ok: false,
        message: `FTP unreachable: ${ftpInfo.host}:${ftpInfo.port} responds as HTTP, not FTP`,
      };
    }
    return { ok: false, message: `FTP unreachable: ${err.message}` };
  } finally {
    client.close();
  }
}

async function installGame(record, game, onProgress, onStatus) {
  onStatus({ status: 'running', progress: 0, message: 'Connecting to FTP...' });

  const ftpInfo = parseFtpUrl(record.ftpUrl);
  const targetPath = record.targetPath || '/';
  const files = game.files.filter(isInstallableFile);
  if (!files.length) {
    throw new Error('No installable NSP/NSZ/XCI/XCZ files found for this game');
  }

  const totalBytes = files.reduce((sum, f) => {
    try {
      const p = localPathForFile(f);
      return sum + fs.statSync(p).size;
    } catch {
      return sum;
    }
  }, 0);

  let uploadedBytes = 0;
  const maxRetries = config.ftp.retryCount;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const client = new ftp.Client(config.ftp.timeout);
    try {
      await client.access({
        host: ftpInfo.host,
        port: ftpInfo.port,
        user: ftpInfo.user,
        password: ftpInfo.pass,
        secure: false,
      });

      await client.cd(targetPath);

      for (const file of files) {
        const localPath = localPathForFile(file);
        if (!fs.existsSync(localPath)) {
          throw new Error(`Local file not found: ${localPath}`);
        }

        onStatus({
          status: 'running',
          progress: totalBytes > 0 ? Math.round((uploadedBytes / totalBytes) * 100) : 0,
          message: `Uploading ${file.fileName}...`,
        });

        const fileSize = await uploadFileWithProgress(client, localPath, file.fileName, (done) => {
          const current = uploadedBytes + done;
          onProgress(totalBytes > 0 ? Math.round((current / totalBytes) * 100) : 0, file.fileName, done, fs.statSync(localPath).size);
        });

        uploadedBytes += fileSize;
      }

      onStatus({
        status: 'completed',
        progress: 100,
        message: `Uploaded ${files.length} file(s)`,
      });
      return;
    } catch (err) {
      const willRetry = attempt < maxRetries;
      onStatus({
        status: willRetry ? 'retrying' : 'failed',
        progress: totalBytes > 0 ? Math.round((uploadedBytes / totalBytes) * 100) : 0,
        message: `Attempt ${attempt}/${maxRetries} failed: ${err.message}`,
      });

      if (willRetry) {
        await sleep(config.ftp.retryIntervalMs);
      } else {
        throw err;
      }
    } finally {
      client.close();
    }
  }
}

module.exports = {
  parseFtpUrl,
  preflightFtp,
  installGame,
};
