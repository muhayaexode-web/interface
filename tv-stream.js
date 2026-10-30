import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import ffmpegPath from 'ffmpeg-static';
import { config } from './config.js';
import { BizError } from './db.js';
import { userFromRequest } from './auth.js';
import { assertTvAccess } from './tv.js';

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: https://sportapi.ai https://media.api-sports.io; media-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

const MAX_PLAYLIST_BYTES = 1_048_576;
const STREAM_TOKEN_TTL_MS = 2 * 60_000;
const TRANSCODE_SESSION_TTL_MS = 15 * 60_000;
const STREAM_USER_AGENT = 'VLC/3.0.16';
const streamTokens = new Map();
const internalStreamTokens = new Map();
const activeTranscodes = new Set();
const transcodeSessions = new Map();
const MAX_ACTIVE_TRANSCODES = 2;
let cachedPlaylist;

export function retainAllChannels(channels) {
  return channels;
}

function isPublicIpv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const value = (((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0);
  const blocked = [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
  ];
  return !blocked.some(([network, bits]) => {
    const net = network.split('.').map(Number);
    const base = (((net[0] << 24) | (net[1] << 16) | (net[2] << 8) | net[3]) >>> 0);
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (base & mask);
  });
}

function probeVideoCodec(inputUrl, internalToken) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    let finished = false;
    let timeout;
    const child = spawn(ffmpegPath, [
      '-hide_banner', '-nostdin', '-loglevel', 'info',
      '-protocol_whitelist', 'http,https,tcp,tls,crypto',
      '-rw_timeout', '15000000',
      '-user_agent', STREAM_USER_AGENT,
      '-headers', `X-BerFoot-Internal: ${internalToken}\r\n`,
      '-i', inputUrl,
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    const finish = (error, codec) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(codec);
    };
    const checkCodec = () => {
      const codec = stderr.match(/\bVideo:\s*([a-z0-9_]+)/i)?.[1]?.toLowerCase();
      if (!codec) return false;
      finish(null, codec);
      child.kill();
      return true;
    };
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8000);
      checkCodec();
    });
    child.once('error', (error) => finish(error));
    child.once('close', () => {
      if (!checkCodec()) finish(new BizError('Impossible de détecter le codec vidéo de la source', 502));
    });
    timeout = setTimeout(() => {
      child.kill();
      finish(new BizError('Délai dépassé pendant la détection du codec vidéo', 504));
    }, 15_000);
  });
}

function assertAllowedStreamUrl(value, allowedOrigins, allowPlaylistReference = false) {
  let upstream;
  try {
    upstream = new URL(value);
  } catch {
    throw new BizError('URL de flux invalide');
  }
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password
      || (isIP(upstream.hostname) && !isPublicIpv4(upstream.hostname))) {
    throw new BizError('Cette source n’est pas autorisée par la playlist', 403);
  }
  if (!allowedOrigins.has(upstream.origin)) {
    if (!allowPlaylistReference) throw new BizError('Cette source n’est pas autorisée par la playlist', 403);
    allowedOrigins.add(upstream.origin);
  }
  upstream.hash = '';
  return upstream;
}

async function getPlaylistData() {
  let stat;
  try {
    stat = await fs.promises.stat(config.streamPlaylistPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new BizError(`La playlist ${path.basename(config.streamPlaylistPath)} est introuvable`, 503);
    }
    throw error;
  }
  if (stat.size > MAX_PLAYLIST_BYTES) throw new BizError('La playlist dépasse la limite de 1 Mio', 413);
  if (cachedPlaylist?.mtimeMs === stat.mtimeMs) return cachedPlaylist;

  const text = (await fs.promises.readFile(config.streamPlaylistPath, 'utf8')).replace(/^\uFEFF/, '');
  const channels = [];
  const origins = new Set();
  let title = '';
  let userAgent = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      title = line.slice(line.lastIndexOf(',') + 1).trim();
    } else if (line.startsWith('#EXTVLCOPT:http-user-agent=')) {
      userAgent = line.slice('#EXTVLCOPT:http-user-agent='.length).trim().slice(0, 256);
    } else if (line.startsWith('#')) {
      continue;
    } else {
      try {
        const url = new URL(line);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
        origins.add(url.origin);
        channels.push({ title: title || `Flux ${channels.length + 1}`, url: url.href, userAgent });
        title = '';
        userAgent = '';
      } catch {
        title = '';
        userAgent = '';
      }
    }
  }
  const allChannels = retainAllChannels(channels);
  if (!allChannels.length) throw new BizError('Aucun flux HTTP(S) valide dans la playlist', 422);
  cachedPlaylist = { mtimeMs: stat.mtimeMs, channels: allChannels, origins };
  return cachedPlaylist;
}

export async function getTvChannels() {
  const playlist = await getPlaylistData();
  return playlist.channels.map((channel, id) => ({ id, title: channel.title }));
}

function createStreamToken(url, userId, allowedOrigins, userAgent = '') {
  const token = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  for (const [key, value] of streamTokens) {
    if (value.expiresAt <= now) streamTokens.delete(key);
  }
  if (streamTokens.size >= 20_000) throw new BizError('Trop de requêtes de flux actives', 503);
  streamTokens.set(token, {
    url: url.href,
    userId,
    allowedOrigins,
    userAgent: /^[\x20-\x7e]{1,256}$/.test(userAgent) ? userAgent : '',
    expiresAt: now + STREAM_TOKEN_TTL_MS,
  });
  return `/api/stream/${token}`;
}

async function getStreamUser(req, db) {
  const internalToken = req.headers['x-berfoot-internal'];
  if (typeof internalToken === 'string') {
    const userId = internalStreamTokens.get(internalToken);
    if (userId) {
      return (await db.get('SELECT id, email, role, balance FROM users WHERE id = ?', userId)) ?? null;
    }
  }
  return userFromRequest(db, req);
}

async function openUpstream(upstream, range, userAgent) {
  const addresses = isIP(upstream.hostname)
    ? [{ address: upstream.hostname, family: 4 }]
    : await dns.lookup(upstream.hostname, { family: 4, all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicIpv4(address))) {
    throw new BizError('Adresse de flux refusée', 403);
  }
  const address = addresses[0];
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': userAgent || 'BerFoot-Stream-Relay/1.0', Accept: '*/*' };
    if (range && /^bytes=\d*-\d*(,\d*-\d*)*$/.test(range) && range.length <= 100) headers.Range = range;
    const transport = upstream.protocol === 'https:' ? https : http;
    const request = transport.request(upstream, {
      method: 'GET',
      headers,
      lookup: (_hostname, options, callback) => {
        const resolved = { address: address.address, family: address.family || 4 };
        if (options?.all) callback(null, [resolved]);
        else callback(null, resolved.address, resolved.family);
      },
      ...(upstream.protocol === 'https:' ? { servername: upstream.hostname } : {}),
      timeout: 30_000,
    }, resolve);
    request.once('timeout', () => request.destroy(new Error('Délai de flux dépassé')));
    request.once('error', reject);
    request.end();
  });
}

function proxiedResourceUrl(resource, base, userId, allowedOrigins, userAgent) {
  const absolute = new URL(resource, base);
  assertAllowedStreamUrl(absolute.href, allowedOrigins, true);
  return createStreamToken(absolute, userId, allowedOrigins, userAgent);
}

function rewriteHlsManifest(text, base, userId, allowedOrigins, userAgent) {
  return text.split(/\r?\n/).map((line) => {
    if (line.startsWith('#')) {
      return line.replace(/URI=(?:"([^"]+)"|'([^']+)'|([^,\s]+))/g, (attribute, doubleQuoted, singleQuoted, bare) => {
        const uri = doubleQuoted ?? singleQuoted ?? bare;
        const quote = doubleQuoted ? '"' : singleQuoted ? "'" : '';
        return `URI=${quote}${proxiedResourceUrl(uri, base, userId, allowedOrigins, userAgent)}${quote}`;
      });
    }
    if (!line.trim()) return line;
    return proxiedResourceUrl(line.trim(), base, userId, allowedOrigins, userAgent);
  }).join('\n');
}

async function relayStream(req, res, db, token) {
  const user = await getStreamUser(req, db);
  if (!user) throw new BizError('Connexion requise', 401);
  await assertTvAccess(db, user);
  let source;
  if (token.startsWith('channel/')) {
    const channelId = Number(token.slice('channel/'.length));
    const playlist = await getPlaylistData();
    const channel = Number.isSafeInteger(channelId) && channelId >= 0
      ? playlist.channels[channelId]
      : null;
    if (!channel) throw new BizError('Chaîne introuvable', 404);
    source = {
      url: channel.url,
      allowedOrigins: new Set(playlist.origins),
      userAgent: channel.userAgent || STREAM_USER_AGENT,
    };
  } else {
    source = streamTokens.get(token);
    if (!source || source.expiresAt <= Date.now() || source.userId !== user.id) {
      streamTokens.delete(token);
      throw new BizError('Lien de flux expiré ou invalide', 404);
    }
    source.expiresAt = Date.now() + STREAM_TOKEN_TTL_MS;
  }
  let upstream = assertAllowedStreamUrl(source.url, source.allowedOrigins);
  let response = await openUpstream(upstream, req.headers.range, source.userAgent);
  for (let redirects = 0; [301, 302, 303, 307, 308].includes(response.statusCode) && redirects < 3; redirects += 1) {
    const location = response.headers.location;
    response.destroy();
    if (!location) throw new BizError('Redirection du flux invalide', 502);
    upstream = assertAllowedStreamUrl(new URL(location, upstream).href, source.allowedOrigins, true);
    response = await openUpstream(upstream, req.headers.range, source.userAgent);
  }
  if (response.statusCode !== 200 && response.statusCode !== 206) {
    const statusCode = response.statusCode;
    response.destroy();
    throw new BizError(`La source du flux a répondu ${statusCode}`, 502);
  }
  const contentType = String(response.headers['content-type'] ?? '').split(';')[0].toLowerCase();
  const isPlaylist = /(?:mpegurl|m3u8)/i.test(contentType) || /\.m3u8?$/i.test(upstream.pathname);

  if (isPlaylist) {
    const chunks = [];
    let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > MAX_PLAYLIST_BYTES) {
        response.destroy();
        throw new BizError('Playlist trop volumineuse', 413);
      }
      chunks.push(chunk);
    }
    let body = Buffer.concat(chunks).toString('utf8');
    if (body.includes('#EXT-X-')) {
      body = rewriteHlsManifest(body, upstream, user.id, source.allowedOrigins, source.userAgent);
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': contentType || 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-store',
    }).end(body);
    return;
  }

  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': contentType || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Accept-Ranges': response.headers['accept-ranges'] ?? 'bytes',
  };
  if (response.statusCode === 206 && response.headers['content-range']) headers['Content-Range'] = response.headers['content-range'];
  if (response.headers['content-length']) headers['Content-Length'] = response.headers['content-length'];
  res.writeHead(response.statusCode, headers);
  res.on('close', () => response.destroy());
  response.pipe(res);
}

async function stopTranscodeSession(sessionId) {
  const session = transcodeSessions.get(sessionId);
  if (!session) return;
  transcodeSessions.delete(sessionId);
  activeTranscodes.delete(session.child);
  internalStreamTokens.delete(session.internalToken);
  if (session.child.exitCode === null && session.child.signalCode === null) {
    const closed = new Promise((resolve) => session.child.once('close', resolve));
    if (!session.child.killed) session.child.kill();
    await closed;
  }
  await fs.promises.rm(session.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function transcodeErrorMessage(session, fallback) {
  const stderr = session.stderr.trim();
  if (/Server returned 403 Forbidden/i.test(stderr)) {
    return 'Le relais a refusé cette source (403). Consultez les journaux du serveur pour connaître la règle appliquée.';
  }
  return stderr.slice(-600) || fallback;
}

async function waitForHlsPlaylist(session) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (session.child.exitCode !== null || session.child.signalCode !== null) {
      throw new BizError(transcodeErrorMessage(session, 'La source n’a pas pu être convertie en HLS'), 502);
    }
    if (session.requestAborted) throw new BizError('Requête de lecture annulée', 499);
    try {
      const playlist = await fs.promises.readFile(path.join(session.directory, 'stream_0.m3u8'), 'utf8');
      if (playlist.includes('#EXTINF:') && /stream_0_\d+\.ts/.test(playlist)) return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new BizError(transcodeErrorMessage(session, 'Délai dépassé en attendant les premiers segments vidéo'), 504);
}

async function startTranscode(req, db, server, channelId) {
  const user = await userFromRequest(db, req);
  if (!user) throw new BizError('Connexion requise', 401);
  await assertTvAccess(db, user);
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    throw new BizError('Le binaire FFmpeg est indisponible sur ce serveur', 503);
  }
  const playlist = await getPlaylistData();
  const channel = playlist.channels[channelId];
  if (!channel) throw new BizError('Chaîne introuvable', 404);
  for (const [sessionId, session] of transcodeSessions) {
    if (session.userId === user.id) await stopTranscodeSession(sessionId);
  }
  if (activeTranscodes.size >= MAX_ACTIVE_TRANSCODES) {
    throw new BizError('Le nombre maximal de lectures simultanées est atteint', 429);
  }

  const address = server.address();
  if (!address || typeof address === 'string') throw new BizError('Serveur de lecture indisponible', 503);
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'berfoot-stream-'));
  const sessionId = crypto.randomBytes(24).toString('hex');
  const internalToken = crypto.randomBytes(32).toString('hex');
  internalStreamTokens.set(internalToken, user.id);
  const session = {
    userId: user.id,
    channelId,
    directory,
    internalToken,
    expiresAt: Date.now() + TRANSCODE_SESSION_TTL_MS,
    requestAborted: false,
    stderr: '',
    child: null,
  };
  const inputUrl = `http://127.0.0.1:${address.port}/api/stream/channel/${channelId}`;
  let child;
  try {
    const videoCodec = await probeVideoCodec(inputUrl, internalToken);
    const videoCodecArgs = videoCodec === 'h264'
      ? ['-c:v', 'copy']
      : ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-g', '48'];
    child = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-protocol_whitelist', 'http,https,tcp,tls,crypto',
      '-fflags', '+nobuffer',
      '-analyzeduration', '2000000', '-probesize', '5000000',
      '-rw_timeout', '20000000',
      '-user_agent', STREAM_USER_AGENT,
      '-headers', `X-BerFoot-Internal: ${internalToken}\r\n`,
      '-i', inputUrl,
      '-map', '0:v:0', '-map', '0:a:0?',
      ...videoCodecArgs,
      '-c:a', 'aac', '-b:a', '128k',
      '-f', 'hls', '-hls_time', '2', '-hls_list_size', '4',
      '-hls_flags', 'delete_segments+append_list+omit_endlist+independent_segments',
      '-hls_segment_filename', path.join(directory, 'stream_0_%06d.ts'),
      path.join(directory, 'stream_0.m3u8'),
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  } catch (error) {
    internalStreamTokens.delete(internalToken);
    await fs.promises.rm(directory, { recursive: true, force: true });
    throw error;
  }
  session.child = child;
  activeTranscodes.add(child);
  transcodeSessions.set(sessionId, session);
  child.stderr.on('data', (chunk) => { session.stderr = `${session.stderr}${chunk}`.slice(-2000); });
  child.once('close', () => { void stopTranscodeSession(sessionId); });
  const onAbort = () => { session.requestAborted = true; };
  req.once('aborted', onAbort);
  try {
    await waitForHlsPlaylist(session);
    if (session.requestAborted) throw new BizError('Requête de lecture annulée', 499);
    session.expiresAt = Date.now() + TRANSCODE_SESSION_TTL_MS;
    return { url: `/api/transcode/session/${sessionId}/stream_0.m3u8` };
  } catch (error) {
    await stopTranscodeSession(sessionId);
    throw error;
  } finally {
    req.off('aborted', onAbort);
  }
}

async function serveTranscodeAsset(req, res, db, sessionId, filename) {
  const user = await userFromRequest(db, req);
  if (!user) throw new BizError('Connexion requise', 401);
  await assertTvAccess(db, user);
  const session = transcodeSessions.get(sessionId);
  if (!session || session.expiresAt <= Date.now() || session.userId !== user.id) {
    await stopTranscodeSession(sessionId);
    throw new BizError('Session de lecture expirée', 404);
  }
  if (!/^(?:playlist|stream_[01])\.m3u8$/.test(filename)
      && !/^stream_[01]_\d+\.ts$/.test(filename)) {
    throw new BizError('Fichier de lecture invalide', 404);
  }
  session.expiresAt = Date.now() + TRANSCODE_SESSION_TTL_MS;
  const file = path.join(session.directory, filename);
  if (filename.endsWith('.m3u8')) {
    let manifest;
    try {
      manifest = await fs.promises.readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') throw new BizError('Playlist HLS indisponible', 404);
      throw error;
    }
    const body = manifest.split(/\r?\n/).map((line) => (
      /^(?:stream_[01]\.m3u8|stream_[01]_\d+\.ts)$/.test(line)
        ? `/api/transcode/session/${sessionId}/${line}`
        : line
    )).join('\n');
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-store',
    }).end(body);
    return;
  }
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'video/mp2t',
    'Cache-Control': 'no-store',
  });
  const stream = fs.createReadStream(file);
  stream.on('error', (error) => {
    if (error.code === 'ENOENT' && !res.headersSent) res.writeHead(404).end();
    else if (!res.destroyed) res.destroy(error);
  });
  stream.pipe(res);
}

async function sendTvStreamError(res, error, label) {
  if (res.headersSent) {
    res.destroy(error);
    return;
  }
  const status = error instanceof BizError ? error.status : 502;
  if (!(error instanceof BizError)) console.error(label, error);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }).end(JSON.stringify({
    error: error instanceof BizError ? error.message : 'Flux vidéo indisponible',
  }));
}

export async function handleTvStreamRequest(req, res, db, server, pathname) {
  const assetMatch = /^\/api\/transcode\/session\/([a-f0-9]{48})\/(playlist\.m3u8|stream_[01]\.m3u8|stream_[01]_\d+\.ts)$/.exec(pathname);
  const transcodeMatch = /^\/api\/transcode\/channel\/(\d+)$/.exec(pathname);
  if (!assetMatch && !transcodeMatch && !pathname.startsWith('/api/stream/')) return false;

  try {
    if (req.method !== 'GET') throw new BizError('Méthode non autorisée', 405);
    if (assetMatch) {
      await serveTranscodeAsset(req, res, db, assetMatch[1], assetMatch[2]);
    } else if (transcodeMatch) {
      const result = await startTranscode(req, db, server, Number(transcodeMatch[1]));
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      }).end(JSON.stringify(result));
    } else {
      const token = pathname.slice('/api/stream/'.length);
      if (!/^(?:channel\/\d+|[a-f0-9]{48})$/.test(token)) throw new BizError('Lien de flux invalide', 404);
      await relayStream(req, res, db, token);
    }
  } catch (error) {
    await sendTvStreamError(
      res,
      error,
      assetMatch ? '[transcode asset]' : transcodeMatch ? '[transcode]' : '[stream relay]',
    );
  }
  return true;
}

export async function stopAllTvStreams() {
  await Promise.all([...transcodeSessions.keys()].map(stopTranscodeSession));
  streamTokens.clear();
  internalStreamTokens.clear();
}

export function expireTvStreams() {
  const now = Date.now();
  for (const [key, value] of streamTokens) {
    if (value.expiresAt <= now) streamTokens.delete(key);
  }
  for (const [id, session] of transcodeSessions) {
    if (session.expiresAt <= now) void stopTranscodeSession(id);
  }
}
