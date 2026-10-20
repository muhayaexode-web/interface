import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // .env optionnel : les variables peuvent venir de l'environnement
}

const int = (name, def) => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? n : def;
};

export const config = {
  port: int('PORT', 3000),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  sessionSecret: process.env.SESSION_SECRET || '',
  adminCode: process.env.ADMIN_CODE || '',
  saspayKey: process.env.SASPAY_API_KEY || '',
  sportApiKey: process.env.SPORTAPI_KEY || '',
  commissionPercent: int('COMMISSION_PERCENT', 10),
  minStake: int('MIN_STAKE', 500),
  maxStake: int('MAX_STAKE', 1_000_000),
  minDeposit: int('MIN_DEPOSIT', 1000),
  minWithdrawal: int('MIN_WITHDRAWAL', 1000),
  country: 'CD',
  currency: 'CDF',
  networks: { airtel_cd: 'Airtel Money', orange_cd: 'Orange Money', vodacom_cd: 'M-Pesa (Vodacom)' },
  databaseUrl: process.env.DATABASE_URL || '',
  publicDir: path.join(ROOT, '..', 'dist'),
};

if (config.sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET manquant ou trop court (32 caractères minimum) dans backend/.env');
}
