import { randomUUID } from 'node:crypto';
import { adjustBalance, BizError, NOW, tx } from './db.js';
import { config } from './config.js';

const BASE = 'https://api.saspay.me/api/v1';

export class SaspayError extends Error {
  constructor(message, status, definitive) {
    super(message);
    this.status = status;
    this.definitive = definitive;
  }
}

export function makeSaspay(fetchImpl = fetch) {
  async function call(method, path, body, idempotencyKey) {
    if (!config.saspayKey) {
      throw new SaspayError('SASPAY_API_KEY manquante dans la configuration', 0, true);
    }

    let response;
    try {
      response = await fetchImpl(`${BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.saspayKey}`,
          'Content-Type': 'application/json',
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(25_000),
      });
    } catch (err) {
      throw new SaspayError(`Réseau SasPay indisponible: ${err.message}`, 0, false);
    }

    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = json.error;
      const message = (typeof error === 'object' && error?.message)
        || json.message
        || `Erreur SasPay ${response.status}`;
      const definitive = response.status >= 400
        && response.status < 500
        && ![408, 409, 429].includes(response.status);
      throw new SaspayError(message, response.status, definitive);
    }
    return json.data ?? json;
  }

  return {
    softpay: (body, key) => call('POST', '/payments/softpay/', body, key),
    verifyPayment: (id) => call('GET', `/payments/${encodeURIComponent(id)}/verify/`),
    payout: (body, key) => call('POST', '/payouts/initialize/', body, key),
    verifyPayout: (id) => call('GET', `/payouts/${encodeURIComponent(id)}/verify/`),
  };
}

function normalizePhone(input) {
  let digits = String(input ?? '').replace(/[\s().-]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('243')) digits = digits.slice(3);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  if (!/^[89]\d{8}$/.test(digits)) {
    throw new BizError('Numéro de téléphone RDC invalide (ex: 0812345678)');
  }
  return `+243${digits}`;
}

function checkPayment(amount, network, minimum) {
  if (!Number.isSafeInteger(amount) || amount < minimum) {
    throw new BizError(`Montant minimum : ${minimum} CDF`);
  }
  if (amount > 10_000_000) throw new BizError('Montant trop élevé');
  if (!Object.hasOwn(config.networks, network)) {
    throw new BizError('Réseau mobile money invalide');
  }
}

const money = (amount) => `${amount}.00`;
const customerOf = (user) => {
  const firstName = user.email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').slice(0, 30) || 'Joueur';
  return { email: user.email, first_name: firstName, last_name: 'BerFoot' };
};

async function markFailed(db, payment, refund) {
  await tx(db, async (t) => {
    const result = await t.run(
      `UPDATE payments SET status = 'failed', updated_at = ${NOW} WHERE id = ? AND status = 'pending'`,
      payment.id,
    );
    if (result.changes === 1 && refund) {
      await adjustBalance(t, payment.user_id, payment.amount, 'withdrawal_refund', payment.id);
    }
  });
}

async function markSuccess(db, payment) {
  await tx(db, async (t) => {
    const result = await t.run(
      `UPDATE payments SET status = 'success', updated_at = ${NOW} WHERE id = ? AND status = 'pending'`,
      payment.id,
    );
    if (result.changes === 1 && payment.kind === 'deposit') {
      await adjustBalance(t, payment.user_id, payment.amount, 'deposit', payment.id);
    }
  });
}

async function initiate(db, sas, payment, user) {
  const idempotencyKey = payment.id;
  const customer = { ...customerOf(user), phone: payment.phone };
  const metadata = { payment_id: payment.id, user_id: user.id };
  let result;

  if (payment.kind === 'deposit') {
    result = await sas.softpay({
      amount: money(payment.amount),
      currency: config.currency,
      country: config.country,
      description: 'Recharge porte-monnaie BerFoot',
      customer,
      network: payment.network,
      metadata,
    }, idempotencyKey);
    await db.run(
      `UPDATE payments SET saspay_id = ?, checkout_url = ?, updated_at = ${NOW} WHERE id = ?`,
      result.id ?? null,
      result.checkout_url || null,
      payment.id,
    );
  } else {
    result = await sas.payout({
      amount: money(payment.amount),
      currency: config.currency,
      country: config.country,
      description: 'Retrait BerFoot',
      customer,
      method: payment.network,
      recipient: { msisdn: payment.phone.replace('+243', '') },
      metadata,
    }, idempotencyKey);
    await db.run(
      `UPDATE payments SET saspay_id = ?, updated_at = ${NOW} WHERE id = ?`,
      result.id ?? null,
      payment.id,
    );
  }
  return result;
}

async function safeInitiate(db, sas, payment, user) {
  try {
    return await initiate(db, sas, payment, user);
  } catch (err) {
    if (err instanceof SaspayError && err.definitive) {
      await markFailed(db, payment, payment.kind === 'withdrawal');
      throw new BizError(err.message, 502);
    }
    return null;
  }
}

async function createPayment(db, sas, user, { amount, network, phone }, kind) {
  const minimum = kind === 'deposit' ? config.minDeposit : config.minWithdrawal;
  checkPayment(amount, network, minimum);
  const normalizedPhone = normalizePhone(phone);
  const id = randomUUID();
  const create = async (t) => {
    const { rows } = await t.run(
      'INSERT INTO payments (id, user_id, kind, amount, network, phone, payment_provider) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *',
      id, user.id, kind, amount, network, normalizedPhone, 'saspay',
    );
    return rows[0];
  };

  const payment = kind === 'withdrawal'
    ? await tx(db, async (t) => {
      const row = await create(t);
      await adjustBalance(t, user.id, -amount, 'withdrawal', id);
      return row;
    })
    : await create(db);

  await safeInitiate(db, sas, payment, user);
  return db.get('SELECT * FROM payments WHERE id = ?', id);
}

export const startDeposit = (db, sas, user, input) =>
  createPayment(db, sas, user, input, 'deposit');

export const startWithdrawal = (db, sas, user, input) =>
  createPayment(db, sas, user, input, 'withdrawal');

const FAILED_STATUSES = new Set(['FAILED', 'CANCELLED', 'CANCELED', 'EXPIRED', 'REJECTED']);

export async function reconcile(db, sas, payment, log = console) {
  if (payment.status !== 'pending') return payment;
  try {
    const user = await db.get('SELECT * FROM users WHERE id = ?', payment.user_id);
    if (!payment.saspay_id) {
      await safeInitiate(db, sas, payment, user);
      return db.get('SELECT * FROM payments WHERE id = ?', payment.id);
    }

    const result = payment.kind === 'deposit'
      ? await sas.verifyPayment(payment.saspay_id)
      : await sas.verifyPayout(payment.saspay_id);
    const status = String(result.status ?? '').toUpperCase();
    if (status === 'SUCCESS') await markSuccess(db, payment);
    else if (FAILED_STATUSES.has(status)) {
      await markFailed(db, payment, payment.kind === 'withdrawal');
    } else if (
      payment.kind === 'deposit'
      && Date.now() - Date.parse(`${payment.created_at.replace(' ', 'T')}Z`) > 24 * 3600_000
    ) {
      await markFailed(db, payment, false);
    }
  } catch (err) {
    log.warn('[SasPay reconciliation]', err.message);
  }
  return db.get('SELECT * FROM payments WHERE id = ?', payment.id);
}
