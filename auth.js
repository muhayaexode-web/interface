import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';
import { BizError } from './db.js';

const scryptAsync = promisify(scrypt);
const COOKIE = 'bf_session';
const TTL_S = 7 * 24 * 3600;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [saltHex, keyHex] = stored.split(':');
  const expected = Buffer.from(keyHex, 'hex');
  const key = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(key, expected);
}

const sign = (payload) => createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');

export function makeToken(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp: Math.floor(Date.now() / 1000) + TTL_S })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function readToken(token) {
  if (typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(payload));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { uid, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return exp > Date.now() / 1000 ? uid : null;
  } catch {
    return null;
  }
}

export const sessionCookie = (token) =>
  `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TTL_S}${config.cookieSecure ? '; Secure' : ''}`;
export const clearCookie = () => `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

export async function userFromRequest(db, req) {
  const raw = (req.headers.cookie ?? '').split(';').map((s) => s.trim()).find((s) => s.startsWith(`${COOKIE}=`));
  const uid = raw ? readToken(raw.slice(COOKIE.length + 1)) : null;
  return uid ? (await db.get('SELECT id, email, role, balance FROM users WHERE id = ?', uid)) ?? null : null;
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function register(db, { email, password, adminCode }) {
  email = String(email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new BizError('Email invalide');
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    throw new BizError('Le mot de passe doit contenir au moins 8 caractères');
  }
  let role = 'user';
  if (adminCode) {
    if (!config.adminCode || !safeEqual(adminCode, config.adminCode)) throw new BizError('Code administrateur invalide', 403);
    role = 'admin';
  }
  const hash = await hashPassword(password);
  try {
    const r = await db.run('INSERT INTO users (email, pass_hash, role) VALUES (?, ?, ?) RETURNING id', email, hash, role);
    return r.rows[0].id;
  } catch (err) {
    if (err.code === '23505') throw new BizError('Un compte existe déjà avec cet email', 409);
    throw err;
  }
}

// Limiteur simple en mémoire contre le brute-force.
const attempts = new Map();
export function throttle(key, max = 10, windowMs = 15 * 60_000) {
  const now = Date.now();
  const arr = (attempts.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) throw new BizError('Trop de tentatives, réessayez plus tard', 429);
  arr.push(now);
  attempts.set(key, arr);
}

const DUMMY = await hashPassword('dummy-password');

export async function login(db, { email, password }) {
  email = String(email ?? '').trim().toLowerCase();
  const u = await db.get('SELECT * FROM users WHERE email = ?', email);
  const ok = await verifyPassword(String(password ?? ''), u ? u.pass_hash : DUMMY);
  if (!u || !ok) throw new BizError('Email ou mot de passe incorrect', 401);
  return u.id;
}
